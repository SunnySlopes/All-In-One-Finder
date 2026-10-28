// Implementation of the minimal Napi:: compatibility layer (see napi.h).
#include "napi.h"

#include <cmath>
#include <stdexcept>

namespace Napi {
namespace detail {

NodePtr make(Type type)
{
    auto node = std::make_shared<Node>();
    node->type = type;
    return node;
}

NodePtr makeBool(bool value)
{
    auto node = make(Type::Boolean);
    node->boolean = value;
    return node;
}

NodePtr makeNumber(double value)
{
    auto node = make(Type::Number);
    node->number = value;
    return node;
}

NodePtr makeString(std::string value)
{
    auto node = make(Type::String);
    node->text = std::move(value);
    return node;
}

NodePtr makeBigInt(int64_t value)
{
    auto node = make(Type::BigInt);
    node->bigint = value;
    return node;
}

NodePtr makeArray(size_t length)
{
    auto node = make(Type::Array);
    node->items.resize(length, make(Type::Undefined));
    return node;
}

NodePtr makeObject()
{
    return make(Type::Object);
}

NodePtr makeBuffer(const void *data, size_t size)
{
    auto node = make(Type::Buffer);
    const auto *bytes = static_cast<const uint8_t *>(data);
    if (bytes && size) node->bytes.assign(bytes, bytes + size);
    return node;
}

uint8_t *bufferData(const NodePtr &node)
{
    if (!node || node->type != Type::Buffer) return nullptr;
    return node->bytes.empty() ? nullptr : node->bytes.data();
}

size_t bufferSize(const NodePtr &node)
{
    if (!node || node->type != Type::Buffer) return 0;
    return node->bytes.size();
}

} // namespace detail

Value::Value(bool value) : node_(detail::makeBool(value)) {}
Value::Value(int32_t value) : node_(detail::makeNumber(static_cast<double>(value))) {}
Value::Value(uint32_t value) : node_(detail::makeNumber(static_cast<double>(value))) {}
Value::Value(int64_t value) : node_(detail::makeNumber(static_cast<double>(value))) {}
Value::Value(double value) : node_(detail::makeNumber(value)) {}
Value::Value(const char *value) : node_(detail::makeString(value ? value : "")) {}
Value::Value(const std::string &value) : node_(detail::makeString(value)) {}

Value Env::Undefined() const { return Value(detail::make(detail::Type::Undefined)); }
Value Env::Null() const { return Value(detail::make(detail::Type::Null)); }

Napi::Env Value::Env() const { return Napi::Env(); }

bool Value::IsUndefined() const { return node_ && node_->type == detail::Type::Undefined; }
bool Value::IsNull() const { return node_ && node_->type == detail::Type::Null; }
bool Value::IsBoolean() const { return node_ && node_->type == detail::Type::Boolean; }
bool Value::IsNumber() const { return node_ && node_->type == detail::Type::Number; }
bool Value::IsString() const { return node_ && node_->type == detail::Type::String; }
bool Value::IsBigInt() const { return node_ && node_->type == detail::Type::BigInt; }
bool Value::IsArray() const { return node_ && node_->type == detail::Type::Array; }
bool Value::IsObject() const { return node_ && node_->type == detail::Type::Object; }
bool Value::IsFunction() const { return node_ && node_->type == detail::Type::Function; }
bool Value::IsBuffer() const { return node_ && node_->type == detail::Type::Buffer; }

Boolean Value::ToBoolean() const
{
    if (!node_) return Boolean(Value(detail::makeBool(false)));
    switch (node_->type)
    {
    case detail::Type::Undefined:
    case detail::Type::Null:
        return Boolean(Value(detail::makeBool(false)));
    case detail::Type::Boolean:
        return Boolean(Value(detail::makeBool(node_->boolean)));
    case detail::Type::Number:
        return Boolean(Value(detail::makeBool(node_->number != 0.0 && !std::isnan(node_->number))));
    case detail::Type::String:
        return Boolean(Value(detail::makeBool(!node_->text.empty())));
    default:
        return Boolean(Value(detail::makeBool(true)));
    }
}

Object Object::New(Napi::Env env)
{
    (void)env;
    return Object(Value(detail::makeObject()));
}

Value Object::Get(const char *name) const
{
    if (!node_ || node_->type != detail::Type::Object || !name) return Value();
    for (const auto &field : node_->fields)
        if (field.first == name) return Value(field.second);
    return Value();
}

Value Object::Get(const std::string &name) const { return Get(name.c_str()); }

bool Object::Has(const char *name) const
{
    if (!node_ || node_->type != detail::Type::Object || !name) return false;
    for (const auto &field : node_->fields)
        if (field.first == name) return true;
    return false;
}

bool Object::Has(const std::string &name) const { return Has(name.c_str()); }

void Object::Set(const char *name, const Value &value)
{
    if (!node_ || node_->type != detail::Type::Object || !name) return;
    for (auto &field : node_->fields)
    {
        if (field.first == name)
        {
            field.second = value.node();
            return;
        }
    }
    node_->fields.emplace_back(name, value.node());
}

void Object::Set(const std::string &name, const Value &value) { Set(name.c_str(), value); }

Array Array::New(Napi::Env env, size_t length)
{
    (void)env;
    return Array(Value(detail::makeArray(length)));
}

uint32_t Array::Length() const
{
    if (!node_ || node_->type != detail::Type::Array) return 0;
    return static_cast<uint32_t>(node_->items.size());
}

Value Array::Get(uint32_t index) const
{
    if (!node_ || node_->type != detail::Type::Array || index >= node_->items.size()) return Value();
    return Value(node_->items[index]);
}

void Array::Set(uint32_t index, const Value &value)
{
    if (!node_ || node_->type != detail::Type::Array) return;
    if (index >= node_->items.size()) node_->items.resize(index + 1, detail::make(detail::Type::Undefined));
    node_->items[index] = value.node();
}

Number Number::New(Napi::Env env, double value)
{
    (void)env;
    return Number(Value(detail::makeNumber(value)));
}

double Number::DoubleValue() const
{
    if (!node_ || node_->type != detail::Type::Number) return 0.0;
    return node_->number;
}

float Number::FloatValue() const { return static_cast<float>(DoubleValue()); }

int32_t Number::Int32Value() const
{
    const double value = DoubleValue();
    if (!std::isfinite(value)) return 0;
    return static_cast<int32_t>(static_cast<uint32_t>(static_cast<int64_t>(std::trunc(value))));
}

int64_t Number::Int64Value() const
{
    const double value = DoubleValue();
    if (!std::isfinite(value)) return 0;
    return static_cast<int64_t>(std::trunc(value));
}

uint32_t Number::Uint32Value() const
{
    const double value = DoubleValue();
    if (!std::isfinite(value)) return 0;
    return static_cast<uint32_t>(static_cast<int64_t>(std::trunc(value)));
}

String String::New(Napi::Env env, const char *value)
{
    (void)env;
    return String(Value(detail::makeString(value ? value : "")));
}

String String::New(Napi::Env env, const std::string &value)
{
    (void)env;
    return String(Value(detail::makeString(value)));
}

std::string String::Utf8Value() const
{
    if (!node_ || node_->type != detail::Type::String) return std::string();
    return node_->text;
}

Boolean Boolean::New(Napi::Env env, bool value)
{
    (void)env;
    return Boolean(Napi::Value(detail::makeBool(value)));
}

bool Boolean::Value() const { return node_ && node_->type == detail::Type::Boolean && node_->boolean; }

BigInt BigInt::New(Napi::Env env, int64_t value)
{
    (void)env;
    return BigInt(Value(detail::makeBigInt(value)));
}

BigInt BigInt::New(Napi::Env env, uint64_t value)
{
    (void)env;
    return BigInt(Value(detail::makeBigInt(static_cast<int64_t>(value))));
}

int64_t BigInt::Int64Value(bool *lossless) const
{
    if (lossless) *lossless = true;
    return node_ && node_->type == detail::Type::BigInt ? node_->bigint : 0;
}

Function Function::New(Napi::Env env, Value (*callback)(const CallbackInfo &))
{
    (void)env;
    auto node = detail::make(detail::Type::Function);
    node->fn = [callback](const CallbackInfo &info) { return callback(info).node(); };
    return Function(Value(std::move(node)));
}

Value Function::Call(const CallbackInfo &info) const
{
    if (!node_ || node_->type != detail::Type::Function || !node_->fn)
        throw Error("not-a-function");
    return Value(node_->fn(info));
}

Error Error::New(Napi::Env env, const char *message)
{
    (void)env;
    return Error(message ? message : "");
}

Error Error::New(Napi::Env env, const std::string &message)
{
    (void)env;
    return Error(message);
}

TypeError TypeError::New(Napi::Env env, const char *message)
{
    (void)env;
    return TypeError(message ? message : "");
}

} // namespace Napi





