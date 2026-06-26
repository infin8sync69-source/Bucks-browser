// Copyright (C) 2026 Michael Kazakov. Subject to GNU General Public License version 3.
#include "Internal.h"
#include "IPFSClusterHost.h"
#include <CFNetwork/CFNetworkErrors.h>
#include <curl/curl.h>

namespace nc::vfs::ipfs_cluster {

const char *HostConfiguration::Tag()
{
    return IPFSClusterHost::UniqueTag;
}

const char *HostConfiguration::Junction() const
{
    return server.c_str();
}

const char *HostConfiguration::VerboseJunction() const
{
    return verbose.c_str();
}

bool HostConfiguration::operator==(const HostConfiguration &_rhs) const
{
    return server == _rhs.server && user == _rhs.user && passwd == _rhs.passwd && https == _rhs.https &&
           port == _rhs.port && proxy_port == _rhs.proxy_port;
}

bool IsOkHTTPRC(const int _rc)
{
    return _rc >= 200 & _rc < 300;
}

std::optional<Error> ToError(const int _curl_rc, const int _http_rc) noexcept
{
    if( _curl_rc == CURLE_OK )
        return HTTPRCToError(_http_rc);
    else
        return CurlRCToError(_curl_rc);
}

std::optional<Error> CurlRCToError(int _curl_rc) noexcept
{
    switch( _curl_rc ) {
        case CURLE_OK:
            return {};
        case CURLE_UNSUPPORTED_PROTOCOL:
            return Error{Error::POSIX, EPROTO};
        case CURLE_FAILED_INIT:
            return Error{Error::POSIX, ENODEV};
        case CURLE_URL_MALFORMAT:
            return Error{Error::POSIX, EINVAL};
        case CURLE_NOT_BUILT_IN:
            return Error{Error::POSIX, EPROTONOSUPPORT};
        case CURLE_COULDNT_RESOLVE_HOST:
            return Error{Error::POSIX, EHOSTUNREACH};
        case CURLE_COULDNT_CONNECT:
            return Error{Error::POSIX, EADDRNOTAVAIL};
        case CURLE_REMOTE_ACCESS_DENIED:
            return Error{Error::POSIX, EACCES};
        case CURLE_OPERATION_TIMEDOUT:
            return Error{Error::POSIX, ETIMEDOUT};
        case CURLE_ABORTED_BY_CALLBACK:
            return Error{Error::POSIX, ECANCELED};
        case CURLE_BAD_FUNCTION_ARGUMENT:
            return Error{Error::POSIX, EINVAL};
        case CURLE_INTERFACE_FAILED:
            return Error{Error::POSIX, ENETDOWN};
        case CURLE_LOGIN_DENIED:
            return Error{Error::POSIX, EAUTH};
        case CURLE_REMOTE_FILE_EXISTS:
            return Error{Error::POSIX, EEXIST};
        case CURLE_SSL_CACERT:
            return Error{Error::NSURL, kCFURLErrorSecureConnectionFailed};
        default:
            return Error{Error::POSIX, EIO};
    }
}

std::optional<Error> HTTPRCToError(int _http_rc) noexcept
{
    if( IsOkHTTPRC(_http_rc) )
        return {};

    switch( _http_rc ) {
        // TODO:: 3xx
        case 400:
            return Error{Error::POSIX, EINVAL};
        case 401:
        case 402:
            return Error{Error::POSIX, EAUTH};
        case 403:
            return Error{Error::POSIX, EACCES};
        case 404:
            return Error{Error::POSIX, ENOENT};
        case 405:
            return Error{Error::POSIX, ENODEV};
        case 406:
            return Error{Error::POSIX, EINVAL};
        case 407:
            return Error{Error::POSIX, ECONNREFUSED};
        case 408:
            return Error{Error::POSIX, ETIMEDOUT};
        case 409:
            return Error{Error::POSIX, EINVAL};
        case 410:
            return Error{Error::POSIX, ENOENT};
        case 411:
        case 412:
            return Error{Error::POSIX, EINVAL};
        case 413:
            return Error{Error::POSIX, EOVERFLOW};
        case 414:
            return Error{Error::POSIX, ENAMETOOLONG};
        case 415:
        case 416:
        case 417:
            return Error{Error::POSIX, EINVAL};
        case 421:
            return Error{Error::POSIX, ECONNABORTED};
        case 422:
            return Error{Error::POSIX, EINVAL};
        case 423:
            return Error{Error::POSIX, EPERM};
        case 424:
        case 428:
            return Error{Error::POSIX, EINVAL};
        case 429:
            return Error{Error::POSIX, EMFILE};
        case 431:
            return Error{Error::POSIX, EOVERFLOW};
        case 507:
            return Error{Error::POSIX, EDQUOT};
        case 508:
            return Error{Error::POSIX, ELOOP};
        default:
            return Error{Error::POSIX, EIO};
    }
}

} // namespace nc::vfs::ipfs_cluster
