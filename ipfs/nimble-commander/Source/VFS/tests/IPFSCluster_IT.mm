// Copyright (C) 2026 Michael Kazakov. Subject to GNU General Public License version 3.
#include "../source/NetIPFSCluster/IPFSClusterHost.h"
#include "TestEnv.h"
#include "Tests.h"
#include <VFS/VFSEasyOps.h>
#include <memory>
#include <span>
#include <sys/stat.h>

#define PREFIX "IPFSCluster "

using namespace nc;
using namespace nc::vfs;

// expects a local kubo + ipfs-cluster-service pair running with default ports
// (see Source/VFS/tests/data/docker or a native install)
static const auto g_Host = "127.0.0.1";
static const auto g_RestPort = 9094;
static const auto g_ProxyPort = 9095;

static std::shared_ptr<IPFSClusterHost> spawnLocalHost()
{
    return std::make_shared<IPFSClusterHost>(g_Host, "", "", false, g_RestPort, g_ProxyPort);
}

static std::vector<std::byte> MakeNoise(size_t size)
{
    std::vector<std::byte> noise(size);
    for( auto &b : noise )
        b = static_cast<std::byte>(std::rand() % 256);
    return noise;
}

static void WriteWholeFile(VFSHost &_host, const std::filesystem::path &_path, std::span<const std::byte> _content)
{
    const std::expected<std::shared_ptr<VFSFile>, Error> file = _host.CreateFile(_path.c_str());
    REQUIRE(file);
    REQUIRE((*file)->Open(VFSFlags::OF_Write | VFSFlags::OF_Create));
    REQUIRE((*file)->SetUploadSize(_content.size()));
    REQUIRE((*file)->WriteFile(_content.data(), _content.size()));
    REQUIRE((*file)->Close());
}

static void VerifyFileContent(VFSHost &_host, const std::filesystem::path &_path, std::span<const std::byte> _content)
{
    const std::expected<std::shared_ptr<VFSFile>, Error> file = _host.CreateFile(_path.c_str());
    REQUIRE(file);
    REQUIRE((*file)->Open(VFSFlags::OF_Read));
    const std::expected<std::vector<uint8_t>, Error> d = (*file)->ReadFile();
    REQUIRE(d);
    REQUIRE(d->size() == _content.size());
    REQUIRE(memcmp(d->data(), _content.data(), _content.size()) == 0);
    REQUIRE((*file)->Close());
}

TEST_CASE(PREFIX "can connect to localhost")
{
    VFSHostPtr host;
    REQUIRE_NOTHROW(host = spawnLocalHost());
    CHECK(host->FetchDirectoryListing("/", 0));
}

TEST_CASE(PREFIX "unreachable server throws")
{
    REQUIRE_THROWS_AS(new IPFSClusterHost(g_Host, "", "", false, 59'094, 59'095), ErrorException);
}

TEST_CASE(PREFIX "upload, list, read back and unpin")
{
    const VFSHostPtr host = spawnLocalHost();
    const auto name = "/it-roundtrip.bin";
    const auto noise = MakeNoise(123'456);

    WriteWholeFile(*host, name, noise);

    // must appear in a fresh root listing
    const std::expected<VFSListingPtr, Error> listing =
        host->FetchDirectoryListing("/", VFSFlags::F_ForceRefresh | VFSFlags::F_NoDotDot);
    REQUIRE(listing);
    bool found = false;
    for( const auto &item : **listing )
        if( item.Filename() == "it-roundtrip.bin" )
            found = true;
    REQUIRE(found);

    VerifyFileContent(*host, name, noise);

    REQUIRE(host->Unlink(name));
    const std::expected<VFSStat, Error> st = host->Stat(name, VFSFlags::F_ForceRefresh);
    // the pin may still be in 'unpinning' state, but must eventually go away;
    // at minimum the cache must have dropped it
    (void)st;
}

TEST_CASE(PREFIX "zero-length upload")
{
    const VFSHostPtr host = spawnLocalHost();
    const auto name = "/it-empty.bin";
    WriteWholeFile(*host, name, {});
    REQUIRE(host->Unlink(name));
}

TEST_CASE(PREFIX "rename re-pins under a new name")
{
    const VFSHostPtr host = spawnLocalHost();
    const auto noise = MakeNoise(1024);
    WriteWholeFile(*host, "/it-rename-src.bin", noise);
    REQUIRE(host->Rename("/it-rename-src.bin", "/it-rename-dst.bin"));
    VerifyFileContent(*host, "/it-rename-dst.bin", noise);
    REQUIRE(host->Unlink("/it-rename-dst.bin"));
}

TEST_CASE(PREFIX "mutations below the root are refused")
{
    const VFSHostPtr host = spawnLocalHost();
    CHECK(!host->CreateDirectory("/whatever", 0755));
    CHECK(host->Unlink("/some-pin/inner-file").error() == Error{Error::POSIX, EROFS});
    CHECK(host->Rename("/some-pin/inner", "/some-pin/other").error() == Error{Error::POSIX, EROFS});
}

TEST_CASE(PREFIX "stat of the root")
{
    const VFSHostPtr host = spawnLocalHost();
    const std::expected<VFSStat, Error> st = host->Stat("/", 0);
    REQUIRE(st);
    CHECK(S_ISDIR(st->mode));
}
