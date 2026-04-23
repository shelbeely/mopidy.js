/**
 * Development server for the mopidy.js web example.
 *
 * Run with: bun --hot examples/server.ts
 * Then open: http://localhost:3000
 */

const port = parseInt(process.env.PORT ?? "3000", 10);

const server = Bun.serve({
  port,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname === "/" ? "/web.html" : url.pathname;

    // Serve files from the examples directory
    const filePath = `${import.meta.dir}${pathname}`;

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(file);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
});

console.log(`Dev server running at http://localhost:${server.port}`);
console.log("Open http://localhost:" + server.port + " in your browser");
