import http from 'node:http';
import handler from 'serve-handler';

const port = Number(process.env.PORT || 4173);

const server = http.createServer((request, response) =>
  handler(request, response, {
    public: 'dist',
    rewrites: [{ source: '**', destination: '/index.html' }]
  })
);

server.listen(port, '0.0.0.0', () => {
  console.log(`Trip Fly ERP frontend listening on port ${port}`);
});
