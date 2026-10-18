/** Private policy used only at the explicit Toil.Script code-loading boundary. */
interface ScriptPolicy {
    createScriptURL(value: string): unknown;
    createScript(value: string, type: string): unknown;
}
interface TrustedTypesFactory {
    createPolicy(
        name: string,
        rules: {
            createScriptURL(value: string): string;
            createScript(value: string, type: string): string;
        },
    ): ScriptPolicy;
}
let policy: ScriptPolicy | undefined;
const inlineUrls = new Set<string>();

export function isDataScript(type: string): boolean {
    const mime = type.toLowerCase().split(';')[0].trim();
    return (
        mime !== '' &&
        mime !== 'module' &&
        !/^(?:text|application)\/(?:x-)?(?:javascript(?:1\.[0-5])?|ecmascript|jscript|livescript)$/.test(
            mime,
        )
    );
}

function scriptUrl(value: string): string {
    const url = new URL(value, document.baseURI);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && !inlineUrls.has(url.href)) {
        throw new TypeError('Toil.Script requires an HTTP(S) script URL.');
    }
    return url.href;
}

function scriptPolicy(): ScriptPolicy | undefined {
    const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypesFactory })
        .trustedTypes;
    if (!factory) return undefined;
    return (policy ??= factory.createPolicy('toil-script', {
        createScriptURL: scriptUrl,
        createScript(value, type) {
            if (!isDataScript(type))
                throw new TypeError('Executable scripts must load through a script URL.');
            return value;
        },
    }));
}

export function setScriptSource(element: HTMLScriptElement, value: string): void {
    const url = scriptUrl(value);
    element.src = (scriptPolicy()?.createScriptURL(url) ?? url) as string;
}

/** A script loaded by trusted code inherits CSP strict-dynamic trust. Inline
 * text would still require its own CSP hash/nonce, so use a private blob URL. */
export function setScriptBody(element: HTMLScriptElement, value: string): void {
    const url = URL.createObjectURL(new Blob([value], { type: 'text/javascript' }));
    inlineUrls.add(url);
    const release = (): void => {
        URL.revokeObjectURL(url);
        inlineUrls.delete(url);
    };
    element.addEventListener('load', release, { once: true });
    element.addEventListener('error', release, { once: true });
    try {
        setScriptSource(element, url);
    } catch (error) {
        release();
        throw error;
    }
}

/** Data blocks remain inline and inert, including JSON-LD and import maps. */
export function setScriptData(element: HTMLScriptElement, value: string): void {
    if (!isDataScript(element.type)) throw new TypeError('Expected an inert script data type.');
    element.text = (scriptPolicy()?.createScript(value, element.type) ?? value) as string;
}
