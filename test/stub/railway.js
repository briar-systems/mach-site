#!/usr/bin/env node
// a stand-in for railway's graphql api, for checking the rebuild the server
// asks for without reaching railway: POST /graphql answers a mutation as
// railway does, a started deployment for the project token given and a 200
// carrying `errors` for any other, and GET /calls answers every mutation
// received so far, so a test can read what the server sent.
// usage: node test/stub/railway.js <port> <token>
"use strict";

const http = require("node:http");

function main() {
  const port = Number(process.argv[2]);
  const token = process.argv[3];
  const calls = [];
  http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      console.log(`${req.method} ${req.url}`);
      const json = (value) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET" && req.url === "/calls") { return json(calls); }
      if (req.method === "POST" && req.url === "/graphql") {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { body = null; }
        if (!body || typeof body.query !== "string") {
          res.writeHead(400);
          return res.end();
        }
        const authorized = req.headers["project-access-token"] === token;
        calls.push({ authorized, type: req.headers["content-type"], query: body.query, variables: body.variables });
        // railway refuses with a 200, never with a status
        if (!authorized) { return json({ errors: [{ message: "Not Authorized" }] }); }
        return json({ data: { serviceInstanceDeployV2: `deployment-${calls.length}` } });
      }
      res.writeHead(404);
      res.end();
    });
  }).listen(port, "127.0.0.1");
}

main();
