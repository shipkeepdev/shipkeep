// Built by real_buildkit_test.go with Railpack and Nixpacks (ADR 0030).
const http = require('node:http');

http
  .createServer((request, response) => {
    response.end(`${process.env.GREETING ?? 'hello'} from the shipkeep build test\n`);
  })
  .listen(Number(process.env.PORT ?? 3000));
