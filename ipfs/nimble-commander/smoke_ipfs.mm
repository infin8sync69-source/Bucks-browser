// Standalone smoke test for the NetIPFSCluster transport/request layer.
// Not part of the Xcode project - build & run with build_smoke.sh.
// Self-contained: uploads its own fixtures, verifies them, and unpins them at the end.
#include "Source/VFS/source/NetIPFSCluster/Internal.h"
#include "Source/VFS/source/NetIPFSCluster/Requests.h"
#include "Source/VFS/source/NetIPFSCluster/ConnectionsPool.h"
#include "Source/VFS/source/NetIPFSCluster/CURLConnection.h"
#include <nlohmann/json.hpp>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// Internal.cpp's Tag() references this static, normally defined in IPFSClusterHost.cpp which we
// don't link here to avoid dragging in the whole VFS layer.
#include "Source/VFS/source/NetIPFSCluster/IPFSClusterHost.h"
namespace nc::vfs {
const char *IPFSClusterHost::UniqueTag = "net_ipfs_cluster";
}

using namespace nc::vfs::ipfs_cluster;

static int g_failures = 0;
#define CHECK(cond, msg)                                                                                               \
    do {                                                                                                               \
        if( cond )                                                                                                     \
            printf("OK: %s\n", msg);                                                                                   \
        else {                                                                                                         \
            printf("FAIL: %s\n", msg);                                                                                 \
            ++g_failures;                                                                                              \
        }                                                                                                              \
    } while( 0 )

struct Part {
    std::string rel_name; // may contain '/' for files inside a directory
    std::string content;
};

// Streams a multipart/form-data add through the same non-blocking Connection mechanism that
// File::Write uses, in deliberately small chunks. Returns the response body (NDJSON when
// stream-channels=true), or "" on failure.
static std::string UploadMultipart(const HostConfiguration &cfg, const std::vector<Part> &parts,
                                   const std::string &query)
{
    const std::string boundary = "----SmokeBoundary42";
    std::string body;
    for( const auto &p : parts ) {
        body += "--" + boundary + "\r\n";
        body += "Content-Disposition: form-data; name=\"file\"; filename=\"" + p.rel_name + "\"\r\n";
        body += "Content-Type: application/octet-stream\r\n\r\n";
        body += p.content;
        body += "\r\n";
    }
    body += "--" + boundary + "--\r\n";

    CURLConnection up(cfg);
    std::ignore = up.SetURL(cfg.rest_url + "add?" + query);
    std::ignore = up.SetCustomRequest("POST");
    const std::string ct = "Content-Type: multipart/form-data; boundary=" + boundary;
    std::ignore = up.SetHeader(std::initializer_list<std::string_view>{ct});
    std::ignore = up.SetNonBlockingUpload(body.size());
    up.MakeNonBlocking();
    auto &wb = up.RequestBody();
    // feed in 64KB chunks to exercise repeated WriteBodyUpToSize calls
    size_t off = 0;
    while( off < body.size() ) {
        const size_t n = std::min<size_t>(64 * 1024, body.size() - off);
        wb.Write(body.data() + off, n);
        if( !up.WriteBodyUpToSize(n) )
            return "";
        off += n;
    }
    if( !up.WriteBodyUpToSize(Connection::ConcludeBodyWrite) )
        return "";
    return up.ResponseBody().ReadAllAsString();
}

// Picks the CID of the entry whose name matches (or the last line if name is empty) out of the
// NDJSON that /add?stream-channels=true returns.
static std::string CidFromAddResponse(const std::string &response, const std::string &name = "")
{
    std::string cid;
    size_t pos = 0;
    while( pos < response.size() ) {
        size_t eol = response.find('\n', pos);
        if( eol == std::string::npos )
            eol = response.size();
        const std::string line = response.substr(pos, eol - pos);
        pos = eol + 1;
        if( line.empty() )
            continue;
        try {
            const auto j = nlohmann::json::parse(line);
            if( name.empty() || j.value("name", "") == name )
                cid = j.contains("cid") ? (j["cid"].is_string() ? j["cid"].get<std::string>()
                                                                : j["cid"].value("/", ""))
                                        : cid;
        } catch( ... ) {
        }
    }
    return cid;
}

static std::string DownloadViaProxyCat(const HostConfiguration &cfg, const std::string &cid_path)
{
    CURLConnection down(cfg);
    std::ignore = down.SetURL(cfg.proxy_url + "api/v0/cat?arg=" + cid_path);
    std::ignore = down.SetCustomRequest("POST");
    down.MakeNonBlocking();
    char buf[65536];
    std::string got;
    while( true ) {
        if( !down.ReadBodyUpToSize(sizeof(buf)) )
            return "";
        const size_t n = down.ResponseBody().Read(buf, sizeof(buf));
        if( n == 0 )
            break;
        got.append(buf, n);
    }
    return got;
}

static bool PinsContain(const std::vector<PinInfo> &pins, const std::string &cid, const char *name = nullptr)
{
    for( const auto &p : pins )
        if( p.cid == cid )
            return name == nullptr || p.name == name;
    return false;
}

int main()
{
    HostConfiguration cfg;
    cfg.server = "127.0.0.1";
    cfg.port = 9094;
    cfg.proxy_port = 9095;
    cfg.https = false;
    cfg.rest_url = "http://127.0.0.1:9094/";
    cfg.proxy_url = "http://127.0.0.1:9095/";

    CURLConnection conn(cfg);
    std::vector<std::string> cleanup; // cids to unpin at the end

    // -- 1. pinset listing ------------------------------------------------------------------
    auto pins0 = RequestPins(cfg, conn);
    CHECK(pins0.has_value(), "RequestPins");
    if( !pins0 )
        return 1;
    printf("  %zu pins in the cluster\n", pins0->size());

    // -- 2. small file upload + stat + download round-trip ----------------------------------
    const std::string small_content = "streamed multipart upload via Connection\n";
    {
        const std::string resp =
            UploadMultipart(cfg, {{"smoke-small.txt", small_content}}, "name=smoke-small.txt&stream-channels=true");
        const std::string cid = CidFromAddResponse(resp);
        CHECK(!cid.empty(), "small file upload returns a cid");
        if( !cid.empty() ) {
            cleanup.push_back(cid);
            conn.Clear();
            auto st = RequestStat(cfg, conn, cid);
            CHECK(st && !st->is_directory && st->size == static_cast<long>(small_content.size()),
                  "RequestStat on small file (size matches)");
            CHECK(DownloadViaProxyCat(cfg, cid) == small_content, "small file download round-trip");
        }
    }

    // -- 3. large file (4 MiB, deterministic pseudo-random) ---------------------------------
    {
        std::string big(4 * 1024 * 1024, '\0');
        uint32_t x = 0x12345678; // xorshift, deterministic across runs
        for( size_t i = 0; i < big.size(); ++i ) {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            big[i] = static_cast<char>(x);
        }
        const std::string resp =
            UploadMultipart(cfg, {{"smoke-large.bin", big}}, "name=smoke-large.bin&stream-channels=true");
        const std::string cid = CidFromAddResponse(resp);
        CHECK(!cid.empty(), "large file upload returns a cid");
        if( !cid.empty() ) {
            cleanup.push_back(cid);
            conn.Clear();
            auto st = RequestStat(cfg, conn, cid);
            CHECK(st && !st->is_directory && st->size == static_cast<long>(big.size()),
                  "RequestStat on large file (4 MiB, size matches)");
            const std::string got = DownloadViaProxyCat(cfg, cid);
            CHECK(got == big, "large file download round-trip (byte-identical)");
        }
    }

    // -- 4. directory upload + listing edge cases --------------------------------------------
    {
        const std::vector<Part> parts = {
            {"smoke-dir/alpha.txt", "alpha content\n"},
            {"smoke-dir/empty.txt", ""},                            // zero-byte file
            {"smoke-dir/name with spaces.txt", "spaces\n"},         // needs URI escaping
            {"smoke-dir/sub/nested.txt", "nested file content\n"},  // nested directory
        };
        const std::string resp = UploadMultipart(cfg, parts, "name=smoke-dir&stream-channels=true&wrap-with-directory=false");
        const std::string dir_cid = CidFromAddResponse(resp, "smoke-dir");
        CHECK(!dir_cid.empty(), "directory upload returns the directory cid");
        if( !dir_cid.empty() ) {
            cleanup.push_back(dir_cid);
            conn.Clear();
            auto st = RequestStat(cfg, conn, dir_cid);
            CHECK(st && st->is_directory, "RequestStat reports directory");
            conn.Clear();
            auto ls = RequestUnixFSListing(cfg, conn, dir_cid);
            CHECK(ls.has_value(), "RequestUnixFSListing on directory");
            if( ls ) {
                bool alpha = false, empty = false, spaces = false, sub = false;
                for( const auto &e : *ls ) {
                    if( e.filename == "alpha.txt" && !e.is_directory && e.size == 14 )
                        alpha = true;
                    if( e.filename == "empty.txt" && !e.is_directory && e.size == 0 )
                        empty = true;
                    if( e.filename == "name with spaces.txt" && !e.is_directory )
                        spaces = true;
                    if( e.filename == "sub" && e.is_directory )
                        sub = true;
                }
                CHECK(ls->size() == 4, "directory listing has exactly 4 entries");
                CHECK(alpha, "listing: regular file with size");
                CHECK(empty, "listing: zero-byte file");
                CHECK(spaces, "listing: filename with spaces");
                CHECK(sub, "listing: nested subdirectory");
            }
            // listing by path one level down
            conn.Clear();
            auto ls2 = RequestUnixFSListing(cfg, conn, dir_cid + "/sub");
            CHECK(ls2 && ls2->size() == 1 && ls2->front().filename == "nested.txt",
                  "RequestUnixFSListing on nested path (cid/sub)");
            // stat of a file by path, incl. escaping
            conn.Clear();
            auto st2 = RequestStat(cfg, conn, dir_cid + "/name with spaces.txt");
            CHECK(st2 && !st2->is_directory && st2->size == 7, "RequestStat on path with spaces");
            // cat of nested file
            CHECK(DownloadViaProxyCat(cfg, dir_cid + "/sub/nested.txt") == "nested file content\n",
                  "download of nested file by path");
        }
    }

    // -- 5. pin rename verified through the pinset -------------------------------------------
    if( !cleanup.empty() ) {
        const std::string &cid = cleanup.front(); // smoke-small.txt
        conn.Clear();
        auto rn = RequestRepinWithName(cfg, conn, cid, "smoke-renamed.txt");
        CHECK(rn.has_value(), "RequestRepinWithName");
        conn.Clear();
        auto pins = RequestPins(cfg, conn);
        CHECK(pins && PinsContain(*pins, cid, "smoke-renamed.txt"), "rename visible in subsequent pin listing");
    }

    // -- 6. error paths (malformed CIDs fail fast, no DHT searches) --------------------------
    {
        conn.Clear();
        auto st = RequestStat(cfg, conn, "not-a-valid-cid");
        CHECK(!st.has_value(), "RequestStat on malformed cid returns error");
        conn.Clear();
        auto ls = RequestUnixFSListing(cfg, conn, "also!!definitely@@not--a--cid");
        CHECK(!ls.has_value(), "RequestUnixFSListing on malformed cid returns error");
        conn.Clear();
        auto rm = RequestUnpin(cfg, conn, "not-a-valid-cid");
        CHECK(!rm.has_value(), "RequestUnpin on malformed cid returns error");
        // listing a plain file is not a directory listing
        if( !cleanup.empty() ) {
            conn.Clear();
            auto lsf = RequestUnixFSListing(cfg, conn, cleanup.front());
            CHECK(!lsf.has_value() || lsf->empty(), "RequestUnixFSListing on a file yields no entries");
        }
    }

    // -- 7. unpin everything we created and verify it is gone --------------------------------
    {
        bool all_unpinned = true;
        for( const auto &cid : cleanup ) {
            conn.Clear();
            if( !RequestUnpin(cfg, conn, cid) )
                all_unpinned = false;
        }
        CHECK(all_unpinned, "RequestUnpin on all created pins");
        conn.Clear();
        auto pins = RequestPins(cfg, conn);
        bool gone = pins.has_value();
        if( pins )
            for( const auto &cid : cleanup )
                if( PinsContain(*pins, cid) )
                    gone = false;
        CHECK(gone, "unpinned cids absent from subsequent pin listing");
    }

    if( g_failures ) {
        printf("SMOKE FAILED: %d failure(s)\n", g_failures);
        return 1;
    }
    printf("SMOKE PASSED\n");
    return 0;
}
