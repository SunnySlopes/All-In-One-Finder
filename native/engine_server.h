// Shared engine server used by the host (--engine child) and by aio-engine.exe.
//
// Loads allinone.dll, exposes a JSON op call, and can serve length-prefixed
// request frames on stdio:
//   request : u32 LE length | {"id":N,"op":"...","args":...}
//   response: u32 LE length | {"id":N,"ok":true,...}
#pragma once

#include <string>

namespace aio {

// Loads allinone.dll from dllPath (or from PATH when empty) and checks the ABI.
bool loadEngine(const std::wstring &dllPath);

// Calls one op. `args` is the JSON text of the single argument ("" for none).
// Returns the DLL envelope ({"ok":...}); never returns nullptr.
std::string callOp(const std::string &op, const std::string &args);

// Handles one request line/object ({"id":N,"op":...,"args":...}) and returns the
// response envelope with the id echoed back. Shared by the frame server and by
// the CLI batch driver so both parse JSON identically.
std::string handleRequest(const std::string &request);

// Serves frames on stdin/stdout until EOF. Returns a process exit code.
int runServer();

} // namespace aio
