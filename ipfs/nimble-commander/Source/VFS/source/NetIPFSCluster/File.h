// Copyright (C) 2026 Michael Kazakov. Subject to GNU General Public License version 3.
#pragma once

#include "IPFSClusterHost.h"
#include <VFS/VFSFile.h>

namespace nc::vfs::ipfs_cluster {

class Connection;

// Reading streams any IPFS path through the cluster's IPFS proxy (/api/v0/cat).
// Writing is only valid at the VFS root: the content is streamed as a multipart body to the
// cluster's /add endpoint, which both imports it into IPFS and pins it across the cluster.
class File final : public VFSFile
{
public:
    File(std::string_view _relative_path, const std::shared_ptr<IPFSClusterHost> &_host);
    ~File() override;

    std::expected<void, Error> Open(unsigned long _open_flags, const VFSCancelChecker &_cancel_checker) override;
    bool IsOpened() const override;
    std::expected<void, Error> Close() override;
    ReadParadigm GetReadParadigm() const override;
    WriteParadigm GetWriteParadigm() const override;
    std::expected<size_t, Error> Read(void *_buf, size_t _size) override;
    std::expected<size_t, Error> Write(const void *_buf, size_t _size) override;
    std::expected<uint64_t, Error> Pos() const override;
    std::expected<uint64_t, Error> Size() const override;
    bool Eof() const override;
    std::expected<void, Error> SetUploadSize(size_t _size) override;

private:
    std::expected<void, Error> SpawnDownloadConnectionIfNeeded();
    std::expected<void, Error> SpawnUploadConnectionIfNeeded();

    IPFSClusterHost &m_Host;
    std::unique_ptr<Connection> m_Conn;
    unsigned long m_OpenFlags = 0;
    long m_Pos = 0;
    long m_Size = -1;
    std::string m_MultipartPrologue;
    std::string m_MultipartEpilogue;
    bool m_EpilogueWritten = false;
};

} // namespace nc::vfs::ipfs_cluster
