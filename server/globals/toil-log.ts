// toiljs aliases the ambient Log to this implementation in every server tier.
// The build flag travels in Wasm, so the native edge uses the same policy as Node.
@external('env', 'server_log')
declare function __toilServerLog(level: i32, ptr: usize, len: i32): i32;

@global
export class ToilLog {
    private static format<T>(value: T): string {
        if (isReference<T>() && changetype<usize>(value) == 0) return 'null';
        if (isDefined(value.toJSON)) return value.toJSON().toString();
        if (isArrayLike<T>()) {
            const parts = new Array<string>(value.length);
            for (let i = 0; i < value.length; i++) parts[i] = ToilLog.format<valueof<T>>(value[i]);
            return '[' + parts.join(',') + ']';
        }
        if (isBoolean<T>() || isInteger<T>() || isFloat<T>() || isString<T>())
            return JSON.stringify<T>(value);
        return value.toString();
    }

    private static write<T>(level: i32, value: T): bool {
        if (isDefined(__TOIL_LOGGING)) {
            if (!__TOIL_LOGGING) return false;
        }
        const message =
            isString<T>() && changetype<usize>(value) != 0
                ? changetype<string>(value)
                : ToilLog.format<T>(value);
        const bytes = Uint8Array.wrap(String.UTF8.encode(message));
        return __toilServerLog(level, bytes.dataStart, bytes.byteLength) == 1;
    }

    static log<T>(value: T): bool {
        return ToilLog.write<T>(0, value);
    }
    static debug<T>(value: T): bool {
        return ToilLog.write<T>(0, value);
    }
    static info<T>(value: T): bool {
        return ToilLog.write<T>(0, value);
    }
    static warn<T>(value: T): bool {
        return ToilLog.write<T>(1, value);
    }
    static error<T>(value: T): bool {
        return ToilLog.write<T>(2, value);
    }
}
