// Interface IDs for the WebView2 interfaces the host talks to.
//
// Why not __uuidof: MinGW's MIDL_INTERFACE does not emit __declspec(uuid), so
// __uuidof(...) compiles into an undefined __mingw_uuidof<T>() symbol and fails at
// link time. The SDK header also does not define the IID_<interface> constants.
// The GUIDs below are copied verbatim from the MIDL_INTERFACE attributes in
// third_party/webview2/include/WebView2.h (1.0.2088.41); keep them in sync when
// the SDK is upgraded.
#pragma once

#include <windows.h>

namespace aio::iid {

inline constexpr GUID IUnknown = {0x00000000, 0x0000, 0x0000,
                                  {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};

// MIDL_INTERFACE("A0D6DF20-3B92-416D-AA0C-437A9C727857")
inline constexpr GUID CoreWebView2_3 = {0xA0D6DF20, 0x3B92, 0x416D,
                                        {0xAA, 0x0C, 0x43, 0x7A, 0x9C, 0x72, 0x78, 0x57}};

// MIDL_INTERFACE("4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d")
inline constexpr GUID CreateEnvironmentCompletedHandler = {
    0x4E8A3389, 0xC9D8, 0x4BD2, {0xB6, 0xB5, 0x12, 0x4F, 0xEE, 0x6C, 0xC1, 0x4D}};

// MIDL_INTERFACE("6c4819f3-c9b7-4260-8127-c9f5bde7f68c")
inline constexpr GUID CreateControllerCompletedHandler = {
    0x6C4819F3, 0xC9B7, 0x4260, {0x81, 0x27, 0xC9, 0xF5, 0xBD, 0xE7, 0xF6, 0x8C}};

// MIDL_INTERFACE("b99369f3-9b11-47b5-bc6f-8e7895fcea17")
inline constexpr GUID AddScriptCompletedHandler = {
    0xB99369F3, 0x9B11, 0x47B5, {0xBC, 0x6F, 0x8E, 0x78, 0x95, 0xFC, 0xEA, 0x17}};

// MIDL_INTERFACE("49511172-cc67-4bca-9923-137112f4c4cc")
inline constexpr GUID ExecuteScriptCompletedHandler = {
    0x49511172, 0xCC67, 0x4BCA, {0x99, 0x23, 0x13, 0x71, 0x12, 0xF4, 0xC4, 0xCC}};
// MIDL_INTERFACE("57213f19-00e6-49fa-8e07-898ea01ecbd2")
inline constexpr GUID WebMessageReceivedHandler = {
    0x57213F19, 0x00E6, 0x49FA, {0x8E, 0x07, 0x89, 0x8E, 0xA0, 0x1E, 0xCB, 0xD2}};

// MIDL_INTERFACE("9adbe429-f36d-432b-9ddc-f8881fbd76e3")
inline constexpr GUID NavigationStartingHandler = {
    0x9ADBE429, 0xF36D, 0x432B, {0x9D, 0xDC, 0xF8, 0x88, 0x1F, 0xBD, 0x76, 0xE3}};

} // namespace aio::iid
