/*
 * HDLBits Submit Tool (C++ / WinHTTP)
 *
 * A lightweight, zero-dependency command-line tool that submits Verilog code
 * to HDLBits (hdlbits.01xz.net) for evaluation.
 *
 * Usage:
 *   hdlbits_submit <file.v>
 *   hdlbits_submit <file.v> --id step_one
 *   hdlbits_submit --login
 *
 * Build (MinGW-w64 / Windows):
 *   g++ -O2 -std=c++17 -s -municode hdlbits_submit.cpp -lwinhttp -o hdlbits_submit.exe
 *
 * Build (Linux / macOS — requires an HTTP library such as libcurl):
 *   (see README.md for cross-platform alternatives)
 *
 * Authentication:
 *   Stores a vlgsession cookie in ~/.hdlbits/cookies.json
 *   Run with --login for setup instructions.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <wchar.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <algorithm>
#include <cctype>

#pragma comment(lib, "winhttp.lib")

namespace fs = std::filesystem;
using namespace std::string_view_literals;

// ── Configuration ──────────────────────────────────────────
constexpr auto BASE_URL    = L"hdlbits.01xz.net";
constexpr auto RUNSIM_PATH = L"/runsim.php";
constexpr auto LOGIN_URL   = L"https://hdlbits.01xz.net/wiki/Special:VlgLogin";
constexpr int  HTTPS_PORT  = 443;

// ── Minimal JSON parser (extracts top-level string values) ─
static std::string json_get_str(std::string_view json, std::string_view key) {
    // Search for "key"
    std::string search = "\"" + std::string(key) + "\"";
    auto pos = json.find(search);
    if (pos == std::string_view::npos) return {};

    // Skip past "key":
    pos = json.find(':', pos + search.size());
    if (pos == std::string_view::npos) return {};

    // Skip whitespace, find opening quote
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t' || json[pos] == '\n' || json[pos] == '\r'))
        pos++;
    if (pos >= json.size() || json[pos] != '"') return {};

    // Find closing quote
    auto end = json.find('"', pos + 1);
    if (end == std::string_view::npos) return {};

    return std::string(json.substr(pos + 1, end - pos - 1));
}

// ── Read file contents ─────────────────────────────────────
static std::string read_file(const fs::path& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// ── Wide string conversion ─────────────────────────────────
static std::wstring to_wstr(std::string_view s) {
    if (s.empty()) return {};
    int len = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w(len, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), len);
    return w;
}

static std::string to_str(std::wstring_view w) {
    if (w.empty()) return {};
    int len = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), len, nullptr, nullptr);
    return s;
}

// ── Cookie loading ─────────────────────────────────────────
static std::string load_vlgsession() {
    fs::path cookie_file = fs::path(getenv("USERPROFILE") ? getenv("USERPROFILE") :
        getenv("HOME") ? getenv("HOME") : ".") / ".hdlbits" / "cookies.json";
    if (!fs::exists(cookie_file)) return {};

    auto content = read_file(cookie_file);
    if (content.empty()) return {};

    return json_get_str(content, "vlgsession");
}

// ── Problem ID inference ───────────────────────────────────
static std::string detect_problem_id(const fs::path& filepath) {
    // Rule 1: first line comment // hdlbits: xxx
    std::ifstream f(filepath);
    if (f) {
        std::string line;
        if (std::getline(f, line)) {
            // Strip leading whitespace
            auto start = line.find_first_not_of(" \t\r");
            if (start != std::string::npos && line.substr(start, 2) == "//") {
                auto comment = line.substr(start + 2);
                // Find hdlbits:
                auto pos = comment.find("hdlbits:");
                if (pos != std::string::npos) {
                    auto id = comment.substr(pos + 8);
                    // Trim whitespace
                    auto s = id.find_first_not_of(" \t");
                    if (s != std::string::npos) {
                        id = id.substr(s);
                        auto e = id.find_last_not_of(" \t\r\n");
                        if (e != std::string::npos)
                            id = id.substr(0, e + 1);
                    }
                    if (!id.empty()) return id;
                }
            }
        }
    }

    // Rule 2: filename stem
    auto stem = filepath.stem().string();
    std::transform(stem.begin(), stem.end(), stem.begin(),
        [](unsigned char c) { return std::tolower(c); });
    return stem;
}

// ── URL encoding (application/x-www-form-urlencoded) ──────
static std::string url_encode(std::string_view s) {
    std::string out;
    out.reserve(s.size() * 3);
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out += (char)c;
        } else if (c == ' ') {
            out += '+';
        } else {
            char buf[4];
            snprintf(buf, sizeof(buf), "%%%02X", c);
            out += buf;
        }
    }
    return out;
}

// ── HTTP POST ──────────────────────────────────────────────
struct HttpResult {
    bool   ok = false;
    DWORD  status = 0;
    std::string body;
    std::string error;
};

static HttpResult http_post(std::wstring_view host, int port, std::wstring_view path,
                             std::string_view body, std::string_view contentType,
                             std::string_view cookie) {
    HttpResult result;

    HINTERNET hSession = WinHttpOpen(
        L"HDLBits-Submit/2.0 (C++)",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) {
        result.error = "WinHttpOpen failed";
        return result;
    }

    HINTERNET hConnect = WinHttpConnect(hSession, host.data(), port, 0);
    if (!hConnect) {
        result.error = "WinHttpConnect failed";
        WinHttpCloseHandle(hSession);
        return result;
    }

    LPCWSTR acceptTypes[] = { L"*/*", nullptr };
    HINTERNET hRequest = WinHttpOpenRequest(
        hConnect, L"POST", path.data(), nullptr,
        WINHTTP_NO_REFERER, acceptTypes,
        WINHTTP_FLAG_SECURE);  // HTTPS

    if (!hRequest) {
        result.error = "WinHttpOpenRequest failed";
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return result;
    }

    // Set Content-Type header
    auto ctW = to_wstr(contentType);
    WinHttpAddRequestHeaders(hRequest,
        (L"Content-Type: " + ctW).c_str(), -1L, WINHTTP_ADDREQ_FLAG_ADD);

    // Set Cookie header
    auto cookieW = to_wstr(cookie);
    WinHttpAddRequestHeaders(hRequest,
        (L"Cookie: " + cookieW).c_str(), -1L, WINHTTP_ADDREQ_FLAG_ADD);

    // Send request (body must be raw bytes, NOT wide-string)
    BOOL sent = WinHttpSendRequest(
        hRequest,
        WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        (LPVOID)body.data(), (DWORD)body.size(),
        (DWORD)body.size(),
        0);

    if (!sent) {
        result.error = "WinHttpSendRequest failed: " + std::to_string(GetLastError());
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return result;
    }

    // Receive response
    if (!WinHttpReceiveResponse(hRequest, nullptr)) {
        result.error = "WinHttpReceiveResponse failed";
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return result;
    }

    // Read status code
    DWORD statusCode = 0;
    DWORD statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(hRequest,
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX,
        &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);
    result.status = statusCode;

    // Read response body
    DWORD bytesRead = 0;
    char buffer[4096];
    while (WinHttpReadData(hRequest, buffer, sizeof(buffer), &bytesRead) && bytesRead > 0) {
        result.body.append(buffer, bytesRead);
    }

    result.ok = (statusCode == 200);
    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return result;
}

// ── Parse HDLBits response ─────────────────────────────────
static std::string parse_response(std::string_view html) {
    // Known status keywords
    const char* keywords[] = {
        "Success!",
        "Compile Error",
        "Simulation Error",
        "Incorrect",
        "Timed Out",
    };

    for (auto kw : keywords) {
        if (html.find(kw) != std::string_view::npos) {
            return kw;
        }
    }

    // Check for mismatch info
    auto pos = html.find("mismatch");
    if (pos != std::string_view::npos) {
        // Extract number
        auto start = html.rfind('>', pos);
        auto text = html.substr(start + 1, pos - start + 20);
        return std::string(text);
    }

    // Fallback: return first portion
    if (html.size() > 200)
        return std::string(html.substr(0, 200));
    return std::string(html);
}

// ── Login help ─────────────────────────────────────────────
static void show_login_help() {
    printf("============================================================\n");
    printf("  HDLBits Login Setup\n");
    printf("============================================================\n\n");
    printf("  In a browser where you are already logged into HDLBits,\n");
    printf("  open F12 → Console and paste:\n\n");
    printf("    copy(JSON.stringify({vlgsession: document.cookie.match(\"vlgsession=([^;]+)\")[1]}))\n\n");
    printf("  Then save the clipboard contents to:\n");
    printf("    %%USERPROFILE%%\\.hdlbits\\cookies.json   (Windows)\n");
    printf("    ~/.hdlbits/cookies.json                   (Linux/macOS)\n\n");
}

// ── Main ───────────────────────────────────────────────────
int wmain(int argc, wchar_t* argv[]) {
    // Windows console UTF-8
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);

    if (argc < 2) {
        printf("HDLBits Submit Tool (C++ / WinHTTP)\n\n");
        printf("Usage:\n");
        printf("  hdlbits_submit <file.v>                Infer problem ID from filename\n");
        printf("  hdlbits_submit <file.v> --id step_one  Explicit problem ID\n");
        printf("  hdlbits_submit --login                 Show login help\n");
        return 0;
    }

    std::string arg1 = to_str(argv[1]);

    // --login
    if (arg1 == "--login") {
        show_login_help();
        return 0;
    }

    // Parse arguments
    fs::path filepath(arg1);
    std::string explicit_id;

    for (int i = 2; i < argc; i++) {
        std::string a = to_str(argv[i]);
        if (a == "--id" && i + 1 < argc) {
            explicit_id = to_str(argv[i + 1]);
            i++;
        }
    }

    if (!fs::exists(filepath)) {
        fprintf(stderr, "ERROR: File not found: %s\n", arg1.c_str());
        return 1;
    }

    // Determine problem ID
    std::string problem_id, source;
    if (!explicit_id.empty()) {
        problem_id = explicit_id;
        source = "--id argument";
    } else {
        problem_id = detect_problem_id(filepath);
        if (problem_id.empty()) {
            fprintf(stderr, "ERROR: Cannot infer problem ID. Use --id to specify.\n");
            fprintf(stderr, "  Or add this comment to the first line: // hdlbits: step_one\n");
            return 1;
        }
        source = "file comment / filename";
    }

    // Load cookie
    std::string vlgsession = load_vlgsession();
    if (vlgsession.empty()) {
        fprintf(stderr, "ERROR: Not logged in.\n\n");
        fprintf(stderr, "Please log in at https://hdlbits.01xz.net first,\n");
        fprintf(stderr, "then run: hdlbits_submit --login\n");
        return 1;
    }
    std::string cookie = "vlgsession=" + vlgsession;

    // Read code
    std::string code = read_file(filepath);
    if (code.empty()) {
        fprintf(stderr, "ERROR: File is empty: %s\n", arg1.c_str());
        return 1;
    }

    printf("Submitting: %s -> %s ...\n", arg1.c_str(), problem_id.c_str());

    // Build form body
    std::string body = "tc=" + url_encode(problem_id) +
                       "&vlgcode_box=" + url_encode(code);

    // Submit
    auto result = http_post(BASE_URL, HTTPS_PORT, RUNSIM_PATH,
                             body, "application/x-www-form-urlencoded", cookie);

    if (!result.ok || result.body.empty()) {
        fprintf(stderr, "ERROR: HTTP %lu - %s\n", result.status, result.error.c_str());
        return 1;
    }

    std::string status = parse_response(result.body);

    printf("\n");
    printf("============================================================\n");
    printf("  Problem: %s\n", problem_id.c_str());
    printf("  Source:  %s\n", source.c_str());
    printf("  Result:  %s\n", status.c_str());
    printf("============================================================\n\n");

    // Structured output for scripts
    if (status == "Success!") {
        printf("success\n");
    } else {
        printf("incorrect\n");
    }

    return (status == "Success!") ? 0 : 1;
}
