"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isExpressApp = isExpressApp;
exports.handleExpressRequest = handleExpressRequest;
const express_1 = require("express");
const url_1 = __importDefault(require("url"));
const stream_1 = require("stream");
const fdk_1 = require("./fdk");
function isExpressApp(handler) {
    return handler instanceof express_1.Router || 'listen' in handler;
}
function handleExpressRequest(app, ctx, resp) {
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
    const completeResponse = (result) => {
        if (responseHandled)
            return;
        responseHandled = true;
        sendExpressResponse(result, ctx, resp);
    };
    const handleError = (error) => {
        if (responseHandled)
            return;
        responseHandled = true;
        handleExpressError(error, resp);
    };
    // Monitor both promise and normal completion
    res.waitForFinish()
        .then(completeResponse)
        .catch(handleError);
    try {
        // Execute Express app
        app(req, res, (err) => {
            if (err) {
                handleError(err);
                return;
            }
            // If no middleware sent a response
            if (!res._finished && !res.headersSent) {
                express404Handler();
            }
        });
    }
    catch (error) {
        handleError(error);
    }
}
function createExpressRequest(ctx, body) {
    const requestURL = ctx.httpGateway.requestURL || '/';
    const parsedUrl = url_1.default.parse(requestURL, true);
    const req = Object.assign(new stream_1.Readable(), {
        method: ctx.httpGateway.method || 'GET',
        url: parsedUrl.pathname || '/',
        originalUrl: requestURL,
        query: parsedUrl.query,
        path: parsedUrl.pathname || '/',
        headers: ctx.headers,
        connection: {},
        httpVersion: '1.1',
    });
    req.push(body);
    req.push(null);
    return req;
}
function createExpressResponse() {
    let _resolve = () => { };
    let _reject = () => { };
    const _promise = new Promise((resolve, reject) => {
        _resolve = resolve;
        _reject = reject;
    });
    const res = {
        _headers: {},
        _status: 200,
        _body: [],
        _finished: false,
        _promise,
        _resolve,
        _reject,
        setHeader(key, value) {
            this._headers[key.toLowerCase()] = value;
        },
        getHeader(key) {
            return this._headers[key.toLowerCase()];
        },
        writeHead(status, headers) {
            this._status = status;
            if (headers) {
                Object.keys(headers).forEach(key => {
                    this._headers[key.toLowerCase()] = headers[key];
                });
            }
        },
        write(chunk) {
            this._body.push(Buffer.from(chunk));
        },
        end(chunk) {
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
        waitForFinish() {
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
function sendExpressResponse(result, ctx, resp) {
    var _a;
    // Check if response is JSON
    const contentType = ((_a = result.headers['content-type']) === null || _a === void 0 ? void 0 : _a[0]) || '';
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
        let jsonBody;
        if (Buffer.isBuffer(result.body)) {
            // Convert Buffer to JSON
            jsonBody = JSON.parse(result.body.toString());
        }
        else if (typeof result.body === 'object') {
            // Already JSON object
            jsonBody = result.body;
        }
        else {
            // String that needs parsing
            jsonBody = JSON.parse(String(result.body));
        }
        ctx.responseContentType = 'application/json';
        (0, fdk_1.sendResult)(ctx, resp, jsonBody);
    }
    else {
        // Non-JSON response
        ctx.responseContentType = contentType || 'application/octet-stream';
        (0, fdk_1.sendResult)(ctx, resp, result.body);
    }
}
function handleExpressError(error, resp) {
    console.error('Express error:', error);
    (0, fdk_1.sendJSONError)(resp, 500, {
        message: 'Internal Server Error',
        detail: error.toString()
    });
}
