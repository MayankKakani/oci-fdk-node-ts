import fs from 'fs';
import http from 'http';
import path from 'path';
import { Readable } from 'stream';
import url from 'url';
import express, { Application, Router } from 'express';

// Type declarations
interface FnHeaders {
    [key: string]: string[];
}

interface FnConfig {
    [key: string]: string | undefined;
}

interface FnResponse {
    status?: number;
    headers: FnHeaders;
    body?: Buffer | string;
}

interface ExpressResponse {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}

type FnHandler = (body: unknown, context: Context) => Promise<unknown> | unknown;

interface ExpressFrameworkOptions {
    framework?: 'express';
    inputMode?: 'buffer' | 'string' | 'json';
}

// Constants
const fnFunctionExceptionMessage = 'Exception in function, consult logs for details';
const fnFunctionBadRequestErrorMessage = 'Bad request';
const runtimeVersion = String(process.version);
const fdkVersion = `fdk-node/${require('./package.json').version} (njsv=${runtimeVersion})`;
const runtimeTag = `node/${runtimeVersion.substr(1, runtimeVersion.length - 1)}`;
const skipHeaders : { [key: string]: boolean } = {
    TE: true,
    Connection: true,
    'Keep-Alive': true,
    'Transfer-Encoding': true,
    Trailer: true,
    Upgrade: true
};

// FnResult classes
abstract class FnResult {
    abstract writeResult(ctx: Context, resp: http.ServerResponse): Promise<void> | void;
}

class StreamResult extends FnResult {
    constructor(private stream: NodeJS.ReadableStream) {
        super();
    }

    writeResult(ctx: Context, resp: http.ServerResponse): Promise<void> {
        return new Promise((resolve, reject) => {
            this.stream.pipe(resp);
            this.stream.on('end', resolve);
            this.stream.on('error', reject);
        });
    }
}

class RawResult extends FnResult {
    constructor(private data: Buffer | string) {
        super();
    }

    writeResult(ctx: Context, resp: http.ServerResponse): void {
        resp.write(this.data);
    }
}

// Input Handlers
abstract class InputHandler {
    abstract pushData(data: Buffer | string): void;
    abstract getBody(): unknown;
}

class BufferInputHandler extends InputHandler {
    private buffers: Buffer[] = [];

    pushData(data: Buffer | string): void {
        this.buffers.push(Buffer.from(data));
    }

    getBody(): Buffer {
        return Buffer.concat(this.buffers);
    }
}

class JSONInputHandler extends InputHandler {
    private str = '';

    pushData(data: Buffer | string): void {
        this.str += data.toString();
    }

    getBody(): unknown {
        try {
            return JSON.parse(this.str);
        } catch (e) {
            return this.str;
        }
    }
}

class StringInputHandler extends InputHandler {
    private str = '';

    pushData(data: Buffer | string): void {
        this.str += data.toString();
    }

    getBody(): string {
        return this.str;
    }
}

// Context classes
class HTTPGatewayContext {
    constructor(private ctx: Context) {}

    get requestURL(): string {
        return this.ctx.getHeader('Fn-Http-Request-Url') || '';
    }

    get method(): string {
        return this.ctx.getHeader('Fn-Http-Method') || '';
    }

    get headers(): FnHeaders {
        const headers: FnHeaders = {};
        for (const key in this.ctx.headers) {
            if (key.startsWith('Fn-Http-H-') && key.length > 'Fn-Http-H-'.length) {
                const headerName = key.substring('Fn-Http-H-'.length);
                headers[headerName] = this.ctx.headers[key];
            }
        }
        return headers;
    }

    getHeader(key: string): string | null {
        return this.ctx.getHeader(`Fn-Http-H-${key}`);
    }

    getAllHeaderValues(key: string): string[] {
        return this.ctx.getAllHeaderValues(`Fn-Http-H-${key}`);
    }

    set statusCode(status: number) {
        this.ctx.setResponseHeader('Fn-Http-Status', status.toString());
    }

    setResponseHeader(key: string, ...values: string[]): void {
        if (this.canonHeader(key) === 'Content-Type') {
            this.ctx.responseContentType = values[0];
        } else {
            this.ctx.setResponseHeader(`Fn-Http-H-${key}`, ...values);
        }
    }

    addResponseHeader(key: string, ...values: string[]): void {
        this.ctx.addResponseHeader(`Fn-Http-H-${key}`, ...values);
    }

    private canonHeader(h: string): string {
        return h.replace(/_/g, '-').split('-').map((part) => {
            if (part) {
                return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            }
            return '';
        }).join('-');
    }
}

class TracingContext {
    isEnabled: boolean;
    traceCollectorUrl: string | undefined;
    traceId: string | null;
    spanId: string | null;
    parentSpanId: string | null;
    sampled: boolean;
    flags: string | null;
    serviceName: string;

    constructor(private ctx: Context) {
        this.isEnabled = parseInt(ctx.config.OCI_TRACING_ENABLED || '0') === 1;
        this.traceCollectorUrl = ctx.config.OCI_TRACE_COLLECTOR_URL;
        this.traceId = ctx.getHeader('X-B3-TraceId');
        this.spanId = ctx.getHeader('X-B3-SpanId');
        this.parentSpanId = ctx.getHeader('X-B3-ParentSpanId');
        this.sampled = parseInt(ctx.getHeader('X-B3-Sampled') || '0') === 1;
        this.flags = ctx.getHeader('X-B3-Flags');
        this.serviceName = `${ctx.appName}::${ctx.fnName}`.toLowerCase();
    }
}

class Context {
    responseHeaders: FnHeaders = {};
    responseContentType?: string;

    constructor(
        public config: FnConfig,
        public body: unknown,
        public headers: FnHeaders
    ) {}

    get deadline(): Date | null {
        const deadStr = this.getHeader('Fn-Deadline');
        return deadStr ? new Date(Date.parse(deadStr)) : null;
    }

    get callID(): string {
        return this.getHeader('Fn-Call-Id') || '';
    }

    get appName(): string {
        return this.config.FN_APP_NAME || '';
    }

    get appID(): string {
        return this.config.FN_APP_ID || '';
    }

    get fnName(): string {
        return this.config.FN_FN_NAME || '';
    }

    get fnID(): string {
        return this.config.FN_FN_ID || '';
    }

    get memory(): number {
        return parseInt(this.config.FN_MEMORY || '0');
    }

    get contentType(): string | null {
        return this.getHeader('Content-Type');
    }

    get tracingContext(): TracingContext {
        return new TracingContext(this);
    }

    get httpGateway(): HTTPGatewayContext {
        return new HTTPGatewayContext(this);
    }

    getAllHeaderValues(key: string): string[] {
        const v = this.headers[this.canonHeader(key)];
        return v ? [...v] : [];
    }

    getHeader(key: string): string | null {
        const h = this.headers[this.canonHeader(key)];
        return h ? h[0] : null;
    }

    getResponseHeader(key: string): string | null {
        const h = this.responseHeaders[this.canonHeader(key)];
        return h ? h[0] : null;
    }

    setResponseHeader(key: string, ...values: string[]): void {
        this.responseHeaders[this.canonHeader(key)] = values;
    }

    addResponseHeader(key: string, ...values: string[]): void {
        const ckey = this.canonHeader(key);
        if (!this.responseHeaders[ckey]) {
            this.responseHeaders[ckey] = [];
        }
        this.responseHeaders[ckey].push(...values);
    }

    private canonHeader(h: string): string {
        return h.replace(/_/g, '-').split('-').map((part) => {
            if (part) {
                return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            }
            return '';
        }).join('-');
    }
}

// Main FDK implementation
export function handle(
    handler: FnHandler | Application | Router,
    options: ExpressFrameworkOptions = {}
): () => void {
    const fnFormat = process.env.FN_FORMAT || '';

    if (isExpressApp(handler)) {
        options.framework = 'express';
        options.inputMode = 'buffer';
    }

    switch (fnFormat.toLowerCase()) {
        case 'http-stream':
            return handleHTTPStream(handler, options);
        default:
            console.error(`Unsupported format: ${fnFormat}`);
            process.exit(2);
    }
}

function isExpressApp(handler: any): boolean {
    return handler instanceof Router || 'listen' in handler;
}

function handleHTTPStream(
    handler: FnHandler | Application | Router,
    options: ExpressFrameworkOptions
): () => void {
    const listenPort = process.env.FN_LISTENER;
    const inputMode = options.inputMode || 'json';
    const framework = options.framework;

    if (!listenPort || !listenPort.startsWith('unix:')) {
        console.error('Invalid FN_LISTENER configuration');
        process.exit(2);
    }

    const listenFile = listenPort.substr('unix:'.length);
    const listenPath = path.dirname(listenFile);
    const tmpFileBaseName = path.basename(listenFile) + '.tmp';
    const tmpFile = path.join(listenPath, tmpFileBaseName);

    const fnLogframeName = process.env.FN_LOGFRAME_NAME || '';
    const fnLogframeHdr = process.env.FN_LOGFRAME_HDR || '';

    const functionHandler = (req: http.IncomingMessage, resp: http.ServerResponse) => {
        const inputHandler = getInputHandler(inputMode);

        if (req.method !== 'POST' || req.url !== '/call') {
            sendJSONError(resp, 400, {
                message: 'Invalid method',
                detail: fnFunctionBadRequestErrorMessage
            });
            return;
        }

        req.on('data', (chunk: Buffer) => {
            inputHandler.pushData(chunk);
        }).on('end', () => {
            const headers = processHeaders(req.rawHeaders);
            const body = inputHandler.getBody();
            const ctx = new Context(process.env, body, headers);
            logFramer(ctx, fnLogframeName, fnLogframeHdr);

            if (framework === 'express') {
                handleExpressRequest(handler as Application | Router, ctx, resp);
            } else {
                invokeUserFunction(handler as FnHandler, ctx, resp);
            }
        }).on('error', (e: Error) => {
            sendJSONError(resp, 500, {
                message: 'Request Error',
                detail: e.toString()
            });
        });
    };

    const currentServer = http.createServer(functionHandler);
    currentServer.keepAliveTimeout = 0;

    currentServer.listen(tmpFile, () => {
        fs.chmodSync(tmpFile, '666');
        fs.symlinkSync(tmpFileBaseName, listenFile);
    });

    currentServer.on('error', (error: Error) => {
        console.error(`Server error: ${error}`);
        process.exit(3);
    });

    return () => {
        currentServer.close();
        fs.unlinkSync(listenFile);
    };
}

function getInputHandler(inputMode: string): InputHandler {
    switch (inputMode) {
        case 'buffer': return new BufferInputHandler();
        case 'string': return new StringInputHandler();
        case 'json': return new JSONInputHandler();
        default: throw new Error(`Unknown input mode: ${inputMode}`);
    }
}

function processHeaders(rawHeaders: string[]): FnHeaders {
    const headers: FnHeaders = {};
    for (let i = 0; i < rawHeaders.length; i += 2) {
        const key = canonHeader(rawHeaders[i]);
        if (skipHeaders[key]) continue;

        const value = rawHeaders[i + 1];
        if (!headers[key]) {
            headers[key] = [value];
        } else {
            headers[key].push(value);
        }
    }
    return headers;
}

function canonHeader(h: string): string {
    return h.replace(/_/g, '-').split('-').map((part) => {
        if (part) {
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        }
        return '';
    }).join('-');
}

function logFramer(ctx: Context, frameName: string, frameHeader: string): void {
    if (frameName && frameHeader) {
        const id = ctx.getHeader(frameHeader);
        if (id) {
            console.log(`\n${frameName}=${id}`);
            console.error(`\n${frameName}=${id}`);
        }
    }
}

function invokeUserFunction(
    fnfunction: FnHandler,
    ctx: Context,
    resp: http.ServerResponse
): void {
    try {
        Promise.resolve(fnfunction(ctx.body, ctx))
            .then((result) => sendResult(ctx, resp, result))
            .catch((error) => handleFunctionError(error, resp));
    } catch (error) {
        handleFunctionError(error as Error, resp);
    }
}

function sendResult(
    ctx: Context,
    resp: http.ServerResponse,
    result: unknown
): void {
    const responseContentType = ctx.responseContentType;
    let isJSON = false;

    if (!responseContentType && result != null) {
        ctx.responseContentType = 'application/json';
        isJSON = true;
    } else if (responseContentType &&
        (responseContentType.startsWith('application/json') ||
            responseContentType.includes('+json'))) {
        isJSON = true;
    }

    for (const key in ctx.responseHeaders) {
        if (ctx.responseHeaders[key]) {
            resp.setHeader(key, ctx.responseHeaders[key]);
        }
    }

    resp.removeHeader('Content-length');
    resp.setHeader('Fn-Fdk-Version', fdkVersion);
    resp.setHeader('Fn-Fdk-Runtime', runtimeTag);
    resp.writeHead(200, 'OK');

    let p: Promise<void> | void | Promise<Awaited<Boolean>>;
    if (result != null) {
        if (result instanceof FnResult) {
            p = Promise.resolve(result.writeResult(ctx, resp));
        } else if (isJSON) {
            p = Promise.resolve(resp.write(JSON.stringify(result)));
        } else if (typeof result === 'string' || Buffer.isBuffer(result)) {
            p = Promise.resolve(resp.write(result));
        }
    }
    // @ts-ignore
    if (p) {
        p.then(() => resp.end(), (err) => {
            console.error('Error writing response:', err);
            resp.end();
        });
    } else {
        resp.end();
    }
}

function sendJSONError(
    resp: http.ServerResponse,
    code: number,
    error: { message: string; detail: string }
): void {
    const errStr = JSON.stringify(error);
    console.warn(`Error ${code}: ${errStr}`);
    resp.setHeader('Content-Type', 'application/json');
    resp.writeHead(code, 'Internal Error');
    resp.end(errStr);
}

function handleFunctionError(
    error: Error,
    resp: http.ServerResponse
): void {
    console.error('Function error:', error);
    sendJSONError(resp, 502, {
        message: fnFunctionExceptionMessage,
        detail: error.toString()
    });
}

// Express-specific handlers
// function handleExpressRequest(
//     app: Application | Router,
//     ctx: Context,
//     resp: http.ServerResponse
// ): void {
//     const body = ctx.body instanceof Buffer ? ctx.body : Buffer.from(String(ctx.body || ''));
//     const req = createExpressRequest(ctx, body);
//     const res = createExpressResponse();
//
//     (app as any)(req, res)
//         .then(() => res.waitForFinish())
//         .then((result: ExpressResponse) => sendExpressResponse(result, ctx, resp))
//         .catch((error: Error) => handleExpressError(error, resp));
// }

function handleExpressRequest(
    app: Application | Router,
    ctx: Context,
    resp: http.ServerResponse
): void {
    const body = ctx.body instanceof Buffer ? ctx.body : Buffer.from(String(ctx.body || ''));
    const req = createExpressRequest(ctx, body);
    const res = createExpressResponse();

    let responseHandled = false;
    // Add 404 handler as the last middleware
    const express404Handler = () => {
        if (!responseHandled) {
            res.status(404).json({
                error: 'Not Found',
                message: `Route ${req.method} ${req.path} not found`
            });
            sendExpressResponse(res, ctx, resp);
        }
    };
    const completeResponse = (result: ExpressResponse) => {
        if (responseHandled) return;
        responseHandled = true;
        sendExpressResponse(result, ctx, resp);
    };

    const handleError = (error: Error) => {
        if (responseHandled) return;
        responseHandled = true;
        handleExpressError(error, resp);
    };

    // Monitor both promise and normal completion
    res.waitForFinish()
        .then(completeResponse)
        .catch(handleError);

    try {
        // Execute Express app
        (app as any)(req, res, (err?: any) => {
            if (err) {
                handleError(err);
                return;
            }

            // If no middleware sent a response
            if (!res._finished && !res.headersSent) {
                express404Handler()
            }
        });
    } catch (error) {
        handleError(error as Error);
    }
}

function createExpressRequest(ctx: Context, body: Buffer): express.Request {
    const requestURL = ctx.httpGateway.requestURL || '/';
    const parsedUrl = url.parse(requestURL, true);
    const req = Object.assign(new Readable(), {
        method: ctx.httpGateway.method || 'GET',
        url: parsedUrl.pathname || '/',
        originalUrl: requestURL,
        query: parsedUrl.query,
        path: parsedUrl.pathname || '/',
        headers: ctx.headers,
        connection: {},
        httpVersion: '1.1',
    }) as unknown as express.Request;

    req.push(body);
    req.push(null);
    return req;
}

function createExpressResponse(): any {
    let _resolve: (value: ExpressResponse) => void = () => {};
    let _reject: (reason?: any) => void = () => {};
    const _promise = new Promise<ExpressResponse>((resolve, reject) => {
        _resolve = resolve;
        _reject = reject;
    });

    const res: any = {
        _headers: {} as Record<string, string>,
        _status: 200,
        _body: [] as Buffer[],
        _finished: false,
        _promise,
        _resolve,
        _reject,

        setHeader(key: string, value: string): void {
            this._headers[key.toLowerCase()] = value;
        },

        getHeader(key: string): string | undefined {
            return this._headers[key.toLowerCase()];
        },

        writeHead(status: number, headers?: Record<string, string>): void {
            this._status = status;
            if (headers) {
                Object.keys(headers).forEach(key => {
                    this._headers[key.toLowerCase()] = headers[key];
                });
            }
        },

        write(chunk: Buffer | string): void {
            this._body.push(Buffer.from(chunk));
        },

        end(chunk?: Buffer | string): void {
            if (chunk) {
                this.write(chunk);
            }
            this._finished = true;
            this._resolve({
                status: this._status,
                headers: this._headers,
                body: Buffer.concat(this._body)
            });
        },

        waitForFinish(): Promise<ExpressResponse> {
            if (this._finished) {
                return Promise.resolve({
                    status: this._status,
                    headers: this._headers,
                    body: Buffer.concat(this._body)
                });
            }
            return this._promise;
        }
    };

    return res;
}

function sendExpressResponse(
    result: ExpressResponse,
    ctx: Context,
    resp: http.ServerResponse
): void {
    // Check if response is JSON
    const contentType = result.headers['content-type']?.[0] || '';
    const isJson = contentType.includes('application/json') ||
        (typeof result.body === 'object');

    // Set status code if provided
    if (result.status) {
        ctx.setResponseHeader('Fn-Http-Status', result.status.toString());
    }

    // Set headers
    for (const [key, value] of Object.entries(result.headers)) {
        if (key.toLowerCase() !== 'content-length') { // Skip content-length
            ctx.setResponseHeader(`Fn-Http-H-${key}`, value);
        }
    }

    // Handle JSON responses properly
    if (isJson) {
        let jsonBody: any;
        if (Buffer.isBuffer(result.body)) {
            // Convert Buffer to JSON
            jsonBody = JSON.parse(result.body.toString());
        } else if (typeof result.body === 'object') {
            // Already JSON object
            jsonBody = result.body;
        } else {
            // String that needs parsing
            jsonBody = JSON.parse(String(result.body));
        }

        ctx.responseContentType = 'application/json';
        sendResult(ctx, resp, jsonBody);
    } else {
        // Non-JSON response
        ctx.responseContentType = contentType || 'application/octet-stream';
        sendResult(ctx, resp, result.body);
    }
}

function handleExpressError(
    error: Error,
    resp: http.ServerResponse
): void {
    console.error('Express error:', error);
    sendJSONError(resp, 500, {
        message: 'Internal Server Error',
        detail: error.toString()
    });
}

// Export public API
export {
    StreamResult,
    RawResult,
    Context,
    HTTPGatewayContext,
    FnResult
};

// Type exports
export type {
    FnHandler,
    ExpressFrameworkOptions
};
