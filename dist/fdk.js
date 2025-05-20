"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FnResult = exports.HTTPGatewayContext = exports.Context = exports.RawResult = exports.StreamResult = void 0;
exports.handle = handle;
exports.sendResult = sendResult;
exports.sendJSONError = sendJSONError;
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const express_wrapper_1 = require("./express-wrapper");
// Constants
const fnFunctionExceptionMessage = 'Exception in function, consult logs for details';
const fnFunctionBadRequestErrorMessage = 'Bad request';
const runtimeVersion = String(process.version);
const fdkVersion = `fdk-node/${require('../package.json').version} (njsv=${runtimeVersion})`;
const runtimeTag = `node/${runtimeVersion.substr(1, runtimeVersion.length - 1)}`;
const skipHeaders = {
    TE: true,
    Connection: true,
    'Keep-Alive': true,
    'Transfer-Encoding': true,
    Trailer: true,
    Upgrade: true
};
// FnResult classes
class FnResult {
}
exports.FnResult = FnResult;
class StreamResult extends FnResult {
    constructor(stream) {
        super();
        this.stream = stream;
    }
    writeResult(ctx, resp) {
        return new Promise((resolve, reject) => {
            this.stream.pipe(resp);
            this.stream.on('end', resolve);
            this.stream.on('error', reject);
        });
    }
}
exports.StreamResult = StreamResult;
class RawResult extends FnResult {
    constructor(data) {
        super();
        this.data = data;
    }
    writeResult(ctx, resp) {
        resp.write(this.data);
    }
}
exports.RawResult = RawResult;
// Input Handlers
class InputHandler {
}
class BufferInputHandler extends InputHandler {
    constructor() {
        super(...arguments);
        this.buffers = [];
    }
    pushData(data) {
        this.buffers.push(Buffer.from(data));
    }
    getBody() {
        return Buffer.concat(this.buffers);
    }
}
class JSONInputHandler extends InputHandler {
    constructor() {
        super(...arguments);
        this.str = '';
    }
    pushData(data) {
        this.str += data.toString();
    }
    getBody() {
        try {
            return JSON.parse(this.str);
        }
        catch (e) {
            return this.str;
        }
    }
}
class StringInputHandler extends InputHandler {
    constructor() {
        super(...arguments);
        this.str = '';
    }
    pushData(data) {
        this.str += data.toString();
    }
    getBody() {
        return this.str;
    }
}
// Context classes
class HTTPGatewayContext {
    constructor(ctx) {
        this.ctx = ctx;
    }
    get requestURL() {
        return this.ctx.getHeader('Fn-Http-Request-Url') || '';
    }
    get method() {
        return this.ctx.getHeader('Fn-Http-Method') || '';
    }
    get headers() {
        const headers = {};
        for (const key in this.ctx.headers) {
            if (key.startsWith('Fn-Http-H-') && key.length > 'Fn-Http-H-'.length) {
                const headerName = key.substring('Fn-Http-H-'.length);
                headers[headerName] = this.ctx.headers[key];
            }
        }
        return headers;
    }
    getHeader(key) {
        return this.ctx.getHeader(`Fn-Http-H-${key}`);
    }
    getAllHeaderValues(key) {
        return this.ctx.getAllHeaderValues(`Fn-Http-H-${key}`);
    }
    set statusCode(status) {
        this.ctx.setResponseHeader('Fn-Http-Status', status.toString());
    }
    setResponseHeader(key, ...values) {
        if (this.canonHeader(key) === 'Content-Type') {
            this.ctx.responseContentType = values[0];
        }
        else {
            this.ctx.setResponseHeader(`Fn-Http-H-${key}`, ...values);
        }
    }
    addResponseHeader(key, ...values) {
        this.ctx.addResponseHeader(`Fn-Http-H-${key}`, ...values);
    }
    canonHeader(h) {
        return h.replace(/_/g, '-').split('-').map((part) => {
            if (part) {
                return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            }
            return '';
        }).join('-');
    }
}
exports.HTTPGatewayContext = HTTPGatewayContext;
class TracingContext {
    constructor(ctx) {
        this.ctx = ctx;
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
    constructor(config, body, headers) {
        this.config = config;
        this.body = body;
        this.headers = headers;
        this.responseHeaders = {};
    }
    get deadline() {
        const deadStr = this.getHeader('Fn-Deadline');
        return deadStr ? new Date(Date.parse(deadStr)) : null;
    }
    get callID() {
        return this.getHeader('Fn-Call-Id') || '';
    }
    get appName() {
        return this.config.FN_APP_NAME || '';
    }
    get appID() {
        return this.config.FN_APP_ID || '';
    }
    get fnName() {
        return this.config.FN_FN_NAME || '';
    }
    get fnID() {
        return this.config.FN_FN_ID || '';
    }
    get memory() {
        return parseInt(this.config.FN_MEMORY || '0');
    }
    get contentType() {
        return this.getHeader('Content-Type');
    }
    get tracingContext() {
        return new TracingContext(this);
    }
    get httpGateway() {
        return new HTTPGatewayContext(this);
    }
    getAllHeaderValues(key) {
        const v = this.headers[this.canonHeader(key)];
        return v ? [...v] : [];
    }
    getHeader(key) {
        const h = this.headers[this.canonHeader(key)];
        return h ? h[0] : null;
    }
    getResponseHeader(key) {
        const h = this.responseHeaders[this.canonHeader(key)];
        return h ? h[0] : null;
    }
    setResponseHeader(key, ...values) {
        this.responseHeaders[this.canonHeader(key)] = values;
    }
    addResponseHeader(key, ...values) {
        const ckey = this.canonHeader(key);
        if (!this.responseHeaders[ckey]) {
            this.responseHeaders[ckey] = [];
        }
        this.responseHeaders[ckey].push(...values);
    }
    canonHeader(h) {
        return h.replace(/_/g, '-').split('-').map((part) => {
            if (part) {
                return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            }
            return '';
        }).join('-');
    }
}
exports.Context = Context;
// Main FDK implementation
function handle(handler, options = {}) {
    const fnFormat = process.env.FN_FORMAT || '';
    if ((0, express_wrapper_1.isExpressApp)(handler)) {
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
function handleHTTPStream(handler, options) {
    const listenPort = process.env.FN_LISTENER;
    const inputMode = options.inputMode || 'json';
    const framework = options.framework;
    if (!listenPort || !listenPort.startsWith('unix:')) {
        console.error('Invalid FN_LISTENER configuration');
        process.exit(2);
    }
    const listenFile = listenPort.substr('unix:'.length);
    const listenPath = path_1.default.dirname(listenFile);
    const tmpFileBaseName = path_1.default.basename(listenFile) + '.tmp';
    const tmpFile = path_1.default.join(listenPath, tmpFileBaseName);
    const fnLogframeName = process.env.FN_LOGFRAME_NAME || '';
    const fnLogframeHdr = process.env.FN_LOGFRAME_HDR || '';
    const functionHandler = (req, resp) => {
        const inputHandler = getInputHandler(inputMode);
        if (req.method !== 'POST' || req.url !== '/call') {
            sendJSONError(resp, 400, {
                message: 'Invalid method',
                detail: fnFunctionBadRequestErrorMessage
            });
            return;
        }
        req.on('data', (chunk) => {
            inputHandler.pushData(chunk);
        }).on('end', () => {
            const headers = processHeaders(req.rawHeaders);
            const body = inputHandler.getBody();
            const ctx = new Context(process.env, body, headers);
            logFramer(ctx, fnLogframeName, fnLogframeHdr);
            if (framework === 'express') {
                (0, express_wrapper_1.handleExpressRequest)(handler, ctx, resp);
            }
            else {
                invokeUserFunction(handler, ctx, resp);
            }
        }).on('error', (e) => {
            sendJSONError(resp, 500, {
                message: 'Request Error',
                detail: e.toString()
            });
        });
    };
    const currentServer = http_1.default.createServer(functionHandler);
    currentServer.keepAliveTimeout = 0;
    currentServer.listen(tmpFile, () => {
        fs_1.default.chmodSync(tmpFile, '666');
        fs_1.default.symlinkSync(tmpFileBaseName, listenFile);
    });
    currentServer.on('error', (error) => {
        console.error(`Server error: ${error}`);
        process.exit(3);
    });
    return () => {
        currentServer.close();
        fs_1.default.unlinkSync(listenFile);
    };
}
function getInputHandler(inputMode) {
    switch (inputMode) {
        case 'buffer': return new BufferInputHandler();
        case 'string': return new StringInputHandler();
        case 'json': return new JSONInputHandler();
        default: throw new Error(`Unknown input mode: ${inputMode}`);
    }
}
function processHeaders(rawHeaders) {
    const headers = {};
    for (let i = 0; i < rawHeaders.length; i += 2) {
        const key = canonHeader(rawHeaders[i]);
        if (skipHeaders[key])
            continue;
        const value = rawHeaders[i + 1];
        if (!headers[key]) {
            headers[key] = [value];
        }
        else {
            headers[key].push(value);
        }
    }
    return headers;
}
function canonHeader(h) {
    return h.replace(/_/g, '-').split('-').map((part) => {
        if (part) {
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        }
        return '';
    }).join('-');
}
function logFramer(ctx, frameName, frameHeader) {
    if (frameName && frameHeader) {
        const id = ctx.getHeader(frameHeader);
        if (id) {
            console.log(`\n${frameName}=${id}`);
            console.error(`\n${frameName}=${id}`);
        }
    }
}
function invokeUserFunction(fnfunction, ctx, resp) {
    try {
        Promise.resolve(fnfunction(ctx.body, ctx))
            .then((result) => sendResult(ctx, resp, result))
            .catch((error) => handleFunctionError(error, resp));
    }
    catch (error) {
        handleFunctionError(error, resp);
    }
}
function sendResult(ctx, resp, result) {
    const responseContentType = ctx.responseContentType;
    let isJSON = false;
    if (!responseContentType && result != null) {
        ctx.responseContentType = 'application/json';
        isJSON = true;
    }
    else if (responseContentType &&
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
    let p;
    if (result != null) {
        if (result instanceof FnResult) {
            p = Promise.resolve(result.writeResult(ctx, resp));
        }
        else if (isJSON) {
            p = Promise.resolve(resp.write(JSON.stringify(result)));
        }
        else if (typeof result === 'string' || Buffer.isBuffer(result)) {
            p = Promise.resolve(resp.write(result));
        }
    }
    // @ts-ignore
    if (p) {
        p.then(() => resp.end(), (err) => {
            console.error('Error writing response:', err);
            resp.end();
        });
    }
    else {
        resp.end();
    }
}
function sendJSONError(resp, code, error) {
    const errStr = JSON.stringify(error);
    console.warn(`Error ${code}: ${errStr}`);
    resp.setHeader('Content-Type', 'application/json');
    resp.writeHead(code, 'Internal Error');
    resp.end(errStr);
}
function handleFunctionError(error, resp) {
    console.error('Function error:', error);
    sendJSONError(resp, 502, {
        message: fnFunctionExceptionMessage,
        detail: error.toString()
    });
}
