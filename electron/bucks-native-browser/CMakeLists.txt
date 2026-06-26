cmake_minimum_required(VERSION 3.16)
project(BucksNativeBrowser VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find Qt 6 dependencies
find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets WebEngineCore WebEngineWidgets Quick Qml WebEngineQuick QuickEffects)

# Find OpenSSL
find_package(OpenSSL REQUIRED)

# Find LevelDB (required by Bucks core)
find_path(LEVELDB_INCLUDE_DIR NAMES leveldb/db.h)
find_library(LEVELDB_LIB NAMES leveldb)
if (NOT LEVELDB_INCLUDE_DIR OR NOT LEVELDB_LIB)
    message(WARNING "LevelDB not found! Some wallet features may be limited.")
endif()

set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

# Bucks Core Directories
if (DEFINED ENV{BUCKS_CORE_DIR})
    set(BUCKS_CORE_DIR $ENV{BUCKS_CORE_DIR})
else()
    # Try multiple common relative layouts
    set(POSSIBLE_PATHS
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../Bucks Blockchain"
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../Blockchain/bucks"
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../Bucks Blockchain"
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../Blockchain/bucks"
        "${CMAKE_CURRENT_SOURCE_DIR}/../Blockchain/bucks"
    )
    set(BUCKS_CORE_DIR "")
    foreach(path ${POSSIBLE_PATHS})
        if (EXISTS "${path}/src/crypto.cpp")
            set(BUCKS_CORE_DIR "${path}")
            break()
        endif()
    endforeach()
    if (BUCKS_CORE_DIR STREQUAL "")
        message(FATAL_ERROR "Bucks Core Blockchain directory not found! Please set BUCKS_CORE_DIR environment variable.")
    endif()
endif()

message(STATUS "Found Bucks Core directory at: ${BUCKS_CORE_DIR}")

include_directories(${BUCKS_CORE_DIR}/include)
include_directories(${BUCKS_CORE_DIR}/external/secp256k1/include)
include_directories(${OPENSSL_INCLUDE_DIR})
include_directories(${LEVELDB_INCLUDE_DIR})

# Define source files
set(SOURCES
    src/main.cpp
    src/mainwindow.cpp
    src/cryptobridge.cpp
    src/slminterface.cpp
    src/stubs.cpp
    ${BUCKS_CORE_DIR}/src/crypto.cpp
    ${BUCKS_CORE_DIR}/src/bip_8192.cpp
    ${BUCKS_CORE_DIR}/src/hd_8192.cpp
    ${BUCKS_CORE_DIR}/src/script.cpp
    ${BUCKS_CORE_DIR}/src/transaction.cpp
    ${BUCKS_CORE_DIR}/src/wallet.cpp
)

set(HEADERS
    src/mainwindow.h
    src/cryptobridge.h
    src/slminterface.h
)

# Application executable
add_executable(BucksNativeBrowser
    ${SOURCES}
    ${HEADERS}
)

# Link Qt and other libraries
target_link_libraries(BucksNativeBrowser PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Widgets
    Qt6::WebEngineCore
    Qt6::WebEngineWidgets
    Qt6::Quick
    Qt6::Qml
    Qt6::WebEngineQuick
    Qt6::QuickEffects
    OpenSSL::SSL
    OpenSSL::Crypto
    ${LEVELDB_LIB}
)
