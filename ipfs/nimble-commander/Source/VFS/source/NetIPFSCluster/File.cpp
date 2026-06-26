// Copyright (C) 2026 Michael Kazakov. Subject to GNU General Public License version 3.
#include "File.h"
#include "Internal.h"
#include "Cache.h"
#include "PathRoutines.h"
#include "ConnectionsPool.h"
#include "Connection.h"
#include "ReadBuffer.h"
#include "WriteBuffer.h"
#include <fmt/core.h>

namespace nc::vfs::ipfs_cluster {

static const std::string g_Boundary = "----NimbleCommanderIPFSClusterBoundary7MA4YWxk";

File::File(std::string_view _relative_path, const std::shared_ptr<IPFSClusterHost> &_host)
    : VFSFile(_relative_path, _host), m_Host(*_host)
{
}

File::~File()
{
    std::ignore = Close();
}

std::expected<void, Error> File::Open(unsigned long _open_flags, const VFSCancelChecker &_cancel_checker)
{
    if( _open_flags & VFSFlags::OF_Append )
        return std::unexpected(Error{Error::POSIX, EPERM});

    if( (_open_flags & (VFSFlags::OF_Read | VFSFlags::OF_Write)) == (VFSFlags::OF_Read | VFSFlags::OF_Write) )
        return std::unexpected(Error{Error::POSIX, EPERM});

    if( _open_flags & VFSFlags::OF_Read ) {
        const std::expected<VFSStat, Error> st = m_Host.Stat(Path(), 0, _cancel_checker);
        if( !st )
            return std::unexpected(st.error());

        if( !S_ISREG(st->mode) )
            return std::unexpected(Error{Error::POSIX, EPERM});

        m_Size = st->size;
        m_OpenFlags = _open_flags;
        return {};
    }
    if( _open_flags & VFSFlags::OF_Write ) {
        // uploads land in the pinset, i.e. only directly at the root
        const std::string_view path = Path();
        if( path.find('/', 1) != std::string_view::npos )
            return std::unexpected(Error{Error::POSIX, EROFS});

        const std::expected<VFSStat, Error> st = m_Host.Stat(Path(), 0, _cancel_checker);

        if( (_open_flags & VFSFlags::OF_NoExist) && st )
            return std::unexpected(Error{Error::POSIX, EEXIST});

        if( (_open_flags & VFSFlags::OF_Create) == 0 && !st )
            return std::unexpected(Error{Error::POSIX, ENOENT});

        if( st && st->mode_bits.dir )
            return std::unexpected(Error{Error::POSIX, EISDIR});

        // an existing pin under this name has to be released first
        if( st ) {
            const std::expected<void, Error> unlink_rc = m_Host.Unlink(Path(), _cancel_checker);
            if( !unlink_rc )
                return unlink_rc;
        }

        m_OpenFlags = _open_flags;
        return {};
    }
    return std::unexpected(Error{Error::POSIX, EINVAL});
}

std::expected<void, Error> File::SpawnDownloadConnectionIfNeeded()
{
    if( m_Conn )
        return {};

    const std::expected<std::string, Error> cid_path = m_Host.ResolveToCidPath(Path(), nullptr);
    if( !cid_path )
        return std::unexpected(cid_path.error());

    m_Conn = m_Host.ConnectionsPool().GetRaw();
    assert(m_Conn);
    const auto url = m_Host.Config().proxy_url + "api/v0/cat?arg=" + URIEscape(*cid_path);
    std::ignore = m_Conn->SetURL(url);
    std::ignore = m_Conn->SetCustomRequest("POST");
    m_Conn->MakeNonBlocking();
    return {};
}

std::expected<void, Error> File::SpawnUploadConnectionIfNeeded()
{
    if( m_Conn )
        return {};

    const std::string filename(std::string_view(Path()).substr(1));
    m_MultipartPrologue = fmt::format("--{}\r\n"
                                      "Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n"
                                      "Content-Type: application/octet-stream\r\n"
                                      "\r\n",
                                      g_Boundary,
                                      filename);
    m_MultipartEpilogue = fmt::format("\r\n--{}--\r\n", g_Boundary);

    m_Conn = m_Host.ConnectionsPool().GetRaw();
    assert(m_Conn);
    const auto url = m_Host.Config().rest_url + "add?name=" + URIEscape(filename) + "&stream-channels=true";
    std::ignore = m_Conn->SetURL(url);
    std::ignore = m_Conn->SetCustomRequest("POST"); // SetNonBlockingUpload defaults to PUT otherwise
    const auto content_type = fmt::format("Content-Type: multipart/form-data; boundary={}", g_Boundary);
    std::ignore = m_Conn->SetHeader(std::initializer_list<std::string_view>{content_type});
    const size_t total = m_MultipartPrologue.size() + static_cast<size_t>(m_Size) + m_MultipartEpilogue.size();
    std::ignore = m_Conn->SetNonBlockingUpload(total);
    m_Conn->MakeNonBlocking();

    // push the multipart header through before any payload bytes
    auto &write_buffer = m_Conn->RequestBody();
    write_buffer.Write(m_MultipartPrologue.data(), m_MultipartPrologue.size());
    return m_Conn->WriteBodyUpToSize(m_MultipartPrologue.size());
}

std::expected<size_t, Error> File::Read(void *_buf, size_t _size)
{
    if( !IsOpened() || !(m_OpenFlags & VFSFlags::OF_Read) )
        return std::unexpected(Error{Error::POSIX, EINVAL});
    if( _size == 0 || Eof() )
        return 0;

    if( const std::expected<void, Error> rc = SpawnDownloadConnectionIfNeeded(); !rc )
        return std::unexpected(rc.error());

    const std::expected<void, Error> read_rc = m_Conn->ReadBodyUpToSize(_size);
    if( !read_rc )
        return std::unexpected(read_rc.error());

    auto &read_buffer = m_Conn->ResponseBody();
    const auto has_read = read_buffer.Read(_buf, _size);
    m_Pos += has_read;

    return has_read;
}

std::expected<size_t, Error> File::Write(const void *_buf, size_t _size)
{
    if( !IsOpened() || !(m_OpenFlags & VFSFlags::OF_Write) || m_Size < 0 )
        return std::unexpected(Error{Error::POSIX, EINVAL});

    if( const std::expected<void, Error> rc = SpawnUploadConnectionIfNeeded(); !rc )
        return std::unexpected(rc.error());

    auto &write_buffer = m_Conn->RequestBody();
    assert(write_buffer.Empty());
    write_buffer.Write(_buf, _size);

    const std::expected<void, Error> write_rc = m_Conn->WriteBodyUpToSize(_size);
    if( !write_rc )
        return std::unexpected(write_rc.error());

    const auto has_written = _size - write_buffer.Size();
    m_Pos += has_written;
    write_buffer.Discard(_size - has_written);

    return has_written;
}

bool File::IsOpened() const
{
    return m_OpenFlags != 0;
}

std::expected<void, Error> File::Close()
{
    if( !IsOpened() )
        return std::unexpected(Error{Error::POSIX, EINVAL});

    std::expected<void, Error> result;

    if( m_OpenFlags & VFSFlags::OF_Read ) {
        if( m_Conn ) {
            std::ignore = m_Conn->ReadBodyUpToSize(Connection::AbortBodyRead);
            m_Host.ConnectionsPool().Return(std::move(m_Conn));
        }
    }
    else if( m_OpenFlags & VFSFlags::OF_Write ) {
        if( m_Size >= 0 ) {
            if( m_Conn == nullptr ) {
                // force a connection to appear, needed for zero-byte uploads
                std::ignore = Write("", 0);
            }

            assert(m_Conn);

            if( m_Pos < m_Size ) {
                result = m_Conn->WriteBodyUpToSize(Connection::AbortBodyWrite);
                if( !result && result.error() == Error{Error::POSIX, ECANCELED} )
                    result = {}; // explicitly eat ECANCELED as we do cancel the upload
            }
            else {
                if( !m_EpilogueWritten ) {
                    m_EpilogueWritten = true;
                    auto &write_buffer = m_Conn->RequestBody();
                    write_buffer.Write(m_MultipartEpilogue.data(), m_MultipartEpilogue.size());
                    result = m_Conn->WriteBodyUpToSize(m_MultipartEpilogue.size());
                }
                if( result )
                    result = m_Conn->WriteBodyUpToSize(Connection::ConcludeBodyWrite);
                if( result ) {
                    m_Host.Cache().CommitMkFile(Path());
                    // the pinset has changed - the next root listing must be fresh
                    m_Host.Cache().DiscardListing("/");
                }
            }

            m_Host.ConnectionsPool().Return(std::move(m_Conn));
        }
    }

    m_OpenFlags = 0;
    m_Pos = 0;
    m_Size = -1;

    return result;
}

File::ReadParadigm File::GetReadParadigm() const
{
    return ReadParadigm::Sequential;
}

File::WriteParadigm File::GetWriteParadigm() const
{
    return WriteParadigm::Upload;
}

std::expected<uint64_t, Error> File::Pos() const
{
    return m_Pos;
}

std::expected<uint64_t, Error> File::Size() const
{
    return m_Size;
}

bool File::Eof() const
{
    if( !IsOpened() )
        return true;
    return m_Pos == m_Size;
}

std::expected<void, Error> File::SetUploadSize(size_t _size)
{
    if( !IsOpened() || m_Size >= 0 )
        return std::unexpected(Error{Error::POSIX, EINVAL});

    m_Size = _size;

    return {};
}

} // namespace nc::vfs::ipfs_cluster
