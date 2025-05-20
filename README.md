# Fn Function Developer Kit for Node.js

This Function Developer Kit makes it easy to deploy Node.js functions with Typescript and expressjs support to Fn.
It currently supports default (cold) and hot functions using the JSON format.

## Creating a Node Function

In order to use this updated Function Development Kit, you need to clone the `./fdk` folder into your current project
under fdk directory and import the handle function into your application code as mentioned in the example below.
This FDK is written in typescript, to run this as a function you need to run `tsc` on your project to compile this into
Javascript and run the generated javascript code using `node ./dist/func.js`

Writing a Node.js function is simply a matter of writing a handler function
that you pass to the FDK to invoke each time your function is called.

This creates a simple hello world function in `func.js`:

```typescript
import { handle } from './fdk';
import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

app.get('/hello', (req: Request, res: Response) => {
    res.send({
        message: 'Hello from TypeScript!'
    });
});

app.get('/hello2', (req: Request, res: Response) => {
    res.send({
        message: 'Hello from TypeScript22!'
    });
});

app.get('/hello3', (req: Request, res: Response) => {
    res.send({
        message: 'Hello from TypeScript333!'
    });
});

handle(app, {framework: "express"});
```

The handler function takes the string input that is sent to the function
and returns a response string.  Using the FDK you don't have to worry about reading
input from standard input and writing to standard output to return your response.
The FDK let's you focus on your function logic and not the mechanics.

Now run it!

```sh
fn deploy --local --app fdkdemo 
fn invoke fdkdemo nodefunc 
```

Now you have a basic running Node function that you can modify and add what you want.


```sh
echo -n '{"name": "Tom"}' | fn invoke fdkdemo nodefunc
```


You should see the result

```sh
{"message": "Hello from TypeScript!"}
```

## Express Request 

To get the Express request context, you can use the Request object part of the express API defination.
you can get the cuurent request context details
path : Get the http request URL of the function as received by the gateway
query :  Get the HTTP request query as received by the gateway
method :  Get the HTTP request method used to invoke the gateway
headers :  Get the HTTP headers of the incoming request (read-only)
:

```typescript
  app.get('/hello', (req: Request, res: Response) => {
    res.send({
        message: process.env.REACH_CONFIG ? process.env.REACH_CONFIG : "config not found"
    });
});
```


<!-- The context contains other context information about the request such as: 

* `req.config` : An Object containing function config variables (from the environment ) (read only)
* `req.headers` : an object containing input headers for the event as lists of strings (read only)
* `req.deadline` : a `Date` object indicating when the function call must be processed by 
* `req.callID` : The call ID of the current call 
* `req.fnID` : The Function ID of the current function 
* `req.memory` : Amount of ram in MB allocated to this function 
* `req.contentType` : The incoming request content type (if set, otherwise null)
* `req.setResponseHeader(key,values...)` : Sets a response header to one or more values 
* `req.addResponseHeader(key,values...)` : Appends values to an existing response header
* `req.responseContentType` set/read the response content type of the function (read/write)
* `req.httpGateway`  The HTTP Gateway context for this function (if set) see `HTTPGatewayContext` below   -->

## Handling non-json input and output

By default the FDK will try and convert input into a JSON object, or fall back to its string format otherwise. 

Likewise by default the output of a function will be treated as a JSON object and converted using JSON.stringify. 


To change the handling of the input you can add an additional `options` parameter to `fdk.handle` that specifies the input handling strategy: 

```typescript
const app = express();
handle(app, {framework: "express", inputMode: 'string'});
```

valid input modes are: 
*  `json` (the default) attempts to parse the input as json or falls back to raw (possibly binary) string value otherwise
* `string` always treats input as a string 
* `buffer` reads input into a `Buffer` object and passes this to your function 

To change the output handling of your function from the default you should wrap the result value using a response decorator: 

> [!NOTE]  the output mode of the function is only JSON, will add support for other types based on requests to implement it.

<!-- the available decorators are: 
* `rawResult({string|Buffer})` passes the result directly to the response - the value can be a string or a buffer - this will not encode quotes on string objects 
* `streamResult({ReadableStream})` pipes the contents of a `ReadableStream` into the output - this allows processing of data from files or HTTP responses  -->


## Using HTTP headers and setting HTTP status codes
You can read http headers passed into a function invocation using `Request.Headers[key]`, this returns the first header value of the header matching `key` (after canonicalization)  and `Request.Headers` which returns an object containing all headers.  

```typescript
import { handle } from './fdk';
import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

app.get('/hello', (req: Request, res: Response) => {
    const contenttype = req.headers['content-type']
    
    res.send({
        message: 'Hello from TypeScript!'
    });
});

handle(app, {framework: "express"});
```

Outbound headers and the HTTP status code can be modified in a similar way:  

```javascript
import { handle } from './fdk';
import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

app.get('/hello', (req: Request, res: Response) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.send({
        message: 'Hello from TypeScript!'
    });
});

handle(app, {framework: "express"});
```
## Fn and Node.js Dependencies
Fn handles Node.js dependencies in the following way:
* If a `package.json` is present without a `node_modules` directory, an Fn build runs an `npm install` within the build process and installs your dependencies.
* If the `node_modules` is present, Fn assumes you have provided the dependencies yourself and no installation is performed.
