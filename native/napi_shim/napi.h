// Minimal Napi:: compatibility layer for the All-In-One Finder engine.
//
// Purpose: compile native/addon.cpp UNCHANGED outside Node/Electron, so the same
// 61 op bindings can be served by allinone.dll (WebView2 host) and by --cli.
// Only the API actually used by addon.cpp is implemented (see the audit in
// docs/鏂囨。/electron-removal-assessment.md 搂2.2):
//   Value/Object/Array/String/Number/Boolean/BigInt/Function/Buffer,
//   CallbackInfo, Error/TypeError, NODE_API_MODULE.
// Not supported on purpose: ObjectWrap, AsyncWorker, Promise, TypedArray, Date,
// ThrowAsJavaScriptException 鈥?addon.cpp uses none of them.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace Napi {

class Env;
class Value;
class Object;
class Array;
class String;
class Number;
class Boolean;
class BigInt;
class Function;
template <typename T> class Buffer;
class Error;
class TypeError;
class CallbackInfo;

namespace detail {

enum class Type
{
    Undefined,
    Null,
    Boolean,
    Number,
    String,
    BigInt,
    Array,
    Object,
    Buffer,
    Function,
};

struct Node;
using NodePtr = std::shared_ptr<Node>;

struct Node
{
    Type type = Type::Undefined;
    bool boolean = false;
    double number = 0.0;
    std::string text;   // String payload
    int64_t bigint = 0; // BigInt payload (all seeds are int64_t)
    std::vector<uint8_t> bytes;
    std::vector<NodePtr> items;                              // Array
    std::vector<std::pair<std::string, NodePtr>> fields;     // Object
    std::function<NodePtr(const CallbackInfo &)> fn;         // Function
};

NodePtr make(Type type);
NodePtr makeBool(bool value);
NodePtr makeNumber(double value);
NodePtr makeString(std::string value);
NodePtr makeBigInt(int64_t value);
NodePtr makeArray(size_t length);
NodePtr makeObject();
NodePtr makeBuffer(const void *data, size_t size);
uint8_t *bufferData(const NodePtr &node);
size_t bufferSize(const NodePtr &node);

} // namespace detail

class Env
{
public:
    Env() = default;
    Value Undefined() const;
    Value Null() const;
};

class Value
{
public:
    Value() : node_(detail::make(detail::Type::Undefined)) {}
    explicit Value(detail::NodePtr node) : node_(std::move(node)) {}

    // Convenience conversions so addon.cpp can call obj.Set("id", 42) directly.
    Value(bool value);
    Value(int32_t value);
    Value(uint32_t value);
    Value(int64_t value);
    Value(double value);
    Value(const char *value);
    Value(const std::string &value);

    const detail::NodePtr &node() const { return node_; }

    template <class T>
    T As() const
    {
        return T(*this);
    }

    bool IsUndefined() const;
    bool IsNull() const;
    bool IsBoolean() const;
    bool IsNumber() const;
    bool IsString() const;
    bool IsBigInt() const;
    bool IsArray() const;
    bool IsObject() const;
    bool IsFunction() const;
    bool IsBuffer() const;
    Boolean ToBoolean() const;
    Napi::Env Env() const;

protected:
    detail::NodePtr node_;
};

class Object : public Value
{
public:
    Object() = default;
    explicit Object(const Value &value) : Value(value) {}

    static Object New(Napi::Env env);
    Value Get(const char *name) const;
    Value Get(const std::string &name) const;
    bool Has(const char *name) const;
    bool Has(const std::string &name) const;
    void Set(const char *name, const Value &value);
    void Set(const std::string &name, const Value &value);
};

class Array : public Value
{
public:
    Array() = default;
    explicit Array(const Value &value) : Value(value) {}

    static Array New(Napi::Env env, size_t length = 0);
    uint32_t Length() const;
    Value Get(uint32_t index) const;
    void Set(uint32_t index, const Value &value);
};

class Number : public Value
{
public:
    Number() = default;
    explicit Number(const Value &value) : Value(value) {}

    static Number New(Napi::Env env, double value);
    double DoubleValue() const;
    float FloatValue() const;
    int32_t Int32Value() const;
    int64_t Int64Value() const;
    uint32_t Uint32Value() const;
};

class String : public Value
{
public:
    String() = default;
    explicit String(const Value &value) : Value(value) {}

    static String New(Napi::Env env, const char *value);
    static String New(Napi::Env env, const std::string &value);
    std::string Utf8Value() const;
};

class Boolean : public Value
{
public:
    Boolean() = default;
    explicit Boolean(const Value &value) : Napi::Value(value) {}

    static Boolean New(Napi::Env env, bool value);
    bool Value() const;
};

class BigInt : public Value
{
public:
    BigInt() = default;
    explicit BigInt(const Value &value) : Value(value) {}

    static BigInt New(Napi::Env env, int64_t value);
    static BigInt New(Napi::Env env, uint64_t value);
    int64_t Int64Value(bool *lossless = nullptr) const;
};

template <typename T>
class Buffer : public Value
{
public:
    Buffer() = default;
    explicit Buffer(const Value &value) : Value(value) {}

    static Buffer Copy(Napi::Env env, const T *data, size_t length)
    {
        (void)env;
        return Buffer(Value(detail::makeBuffer(data, length * sizeof(T))));
    }

    T *Data() const { return reinterpret_cast<T *>(detail::bufferData(node())); }
    size_t Length() const { return detail::bufferSize(node()) / sizeof(T); }
    size_t ByteLength() const { return detail::bufferSize(node()); }
};

class Function : public Value
{
public:
    Function() = default;
    explicit Function(const Value &value) : Value(value) {}

    static Function New(Napi::Env env, Value (*callback)(const CallbackInfo &));
    Value Call(const CallbackInfo &info) const;
};

class CallbackInfo
{
public:
    CallbackInfo(Napi::Env env, std::vector<Value> args)
        : env_(env), args_(std::move(args)) {}

    Napi::Env Env() const { return env_; }
    size_t Length() const { return args_.size(); }
    Value operator[](size_t index) const
    {
        return index < args_.size() ? args_[index] : Value();
    }

private:
    Napi::Env env_;
    std::vector<Value> args_;
};

class Error
{
public:
    Error() = default;
    explicit Error(std::string message) : message_(std::move(message)) {}

    static Error New(Napi::Env env, const char *message);
    static Error New(Napi::Env env, const std::string &message);
    const char *what() const noexcept { return message_.c_str(); }
    const std::string &Message() const { return message_; }

private:
    std::string message_;
};

class TypeError : public Error
{
public:
    TypeError() = default;
    using Error::Error;

    static TypeError New(Napi::Env env, const char *message);
};

} // namespace Napi

// Registers Init(Env, Object) into the shared engine; aio_capi.cpp calls it once.
#define NODE_API_MODULE(modname, regfunc)                                  \
    extern "C" void aio_napi_init(Napi::Env env, Napi::Object exports) {   \
        (void)::regfunc(env, exports);                                     \
    }


