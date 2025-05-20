import express, {Application, Router} from "express";
import http from "http";
import url from "url";
import {Readable} from "stream";
import {Context, sendJSONError, sendResult} from "./fdk";

export interface ExpressResponse {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}
export interface ExpressFrameworkOptions {
    framework?: 'express';
    inputMode?: 'buffer' | 'string' | 'json';
}

export function isExpressApp(handler: any): boolean {
    return handler instanceof Router || 'listen' in handler;
}


export function handleExpressRequest(
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
