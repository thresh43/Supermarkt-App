// Builds www/: inlines the shared library, styles and app code into one HTML file for the
// Android WebView, and bundles the background runner with the same shared library.
const fs = require("fs");
const read = f => fs.readFileSync(__dirname + "/" + f, "utf8");
fs.mkdirSync(__dirname + "/www/runners", { recursive: true });
const html = read("src/index.html")
  .replace("/*CSS*/", () => read("src/style.css"))
  // The native bridge alone has no registerPlugin(); the Capacitor core runtime adds it.
  .replace("/*JS*/", () => read("node_modules/@capacitor/core/dist/capacitor.js").replace(/\/\/# sourceMappingURL.*/, "") + "\n" + read("src/lib.js") + "\n" + read("src/app.js"));
fs.writeFileSync(__dirname + "/www/index.html", html);
fs.writeFileSync(__dirname + "/www/runners/offers.js", read("src/lib.js") + "\n" + read("runners/offers.js"));
console.log("www built");
