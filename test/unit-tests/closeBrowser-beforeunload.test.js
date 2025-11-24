const expect = require("chai").expect;
const { openBrowser, closeBrowser, goto } = require("../../lib/taiko");
const { openBrowserArgs } = require("./test-util");
const fs = require("fs-extra");
const path = require("node:path");
const os = require("node:os");

describe("closeBrowser with beforeunload dialog", () => {
  let tempHtmlPath;

  before(() => {
    // Create a temporary HTML file with beforeunload handler
    const tempDir = os.tmpdir();
    tempHtmlPath = path.join(tempDir, "taiko-test-beforeunload.html");
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <title>Beforeunload Test</title>
</head>
<body>
  <h1>Test Page</h1>
  <input type="text" id="testInput" value="">
  <script>
    // Add beforeunload handler
    window.addEventListener('beforeunload', function(e) {
      e.preventDefault();
      e.returnValue = 'Are you sure you want to leave?';
      return e.returnValue;
    });

    // Trigger the beforeunload condition by modifying the page
    document.getElementById('testInput').addEventListener('input', function() {
      // This makes the page "dirty" and triggers beforeunload
    });
  </script>
</body>
</html>
    `;
    fs.writeFileSync(tempHtmlPath, htmlContent);
  });

  after(() => {
    // Clean up temp file
    if (fs.existsSync(tempHtmlPath)) {
      fs.unlinkSync(tempHtmlPath);
    }
  });

  it("should close browser without error when page has beforeunload handler", async () => {
    await openBrowser(openBrowserArgs);

    // Navigate to the page with beforeunload handler
    await goto(`file://${tempHtmlPath}`);

    // closeBrowser should handle the beforeunload dialog automatically without throwing
    let error = null;
    try {
      await closeBrowser();
    } catch (e) {
      error = e;
    }

    expect(error).to.be.null;
  });
});
