import { handle } from '../src/fdk';
import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

app.get('/hello', (req: Request, res: Response) => {
    res.send({
        message: process.env.REACH_CONFIG ? process.env.REACH_CONFIG : "config not found"
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