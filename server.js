const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 10000;

function cleanHtml(html) {
  if (!html) return null;
  try {
    const $ = cheerio.load(html);
    $("script, style, nav, footer, iframe, header, form, svg, noscript, .ad, .advertisement, [id*=\"cookie\"], [class*=\"cookie\"], [class*=\"paywall\"]").remove();
    return $.html();
  } catch (e) {
    return html;
  }
}

async function extractDirect(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const text = await res.text();
      const cleaned = cleanHtml(text);
      if (cleaned && cleaned.length > 50) return cleaned;
    }
  } catch (err) {
    console.error("Stage 1 Direct error:", err.message);
  }
  return null;
}

async function extractArchive(url) {
  try {
    const res = await fetch("https://archive.ph/newest/" + url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 200 && !text.toLowerCase().includes("captcha")) {
        return cleanHtml(text);
      }
    }
  } catch (err) {
    console.error("Stage 2 Archive error:", err.message);
  }
  return null;
}

async function extractMorss(url) {
  try {
    const res = await fetch("https://morss.it/" + url, {
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 100) return cleanHtml(text);
    }
  } catch (err) {
    console.error("Stage 3 Morss error:", err.message);
  }
  return null;
}

app.get("/", (req, res) => {
  res.send("QuickRSS Proxy is active. Usage: /extract?url=URL");
});

app.get("/extract", async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("Missing ?url= parameter");

    console.log("Extracting: " + targetUrl);

    let html = await extractDirect(targetUrl);
    if (html) {
      console.log("Stage 1 succeeded");
      return res.type("html").send(html);
    }

    console.log("Stage 1 failed, trying Stage 2...");
    html = await extractArchive(targetUrl);
    if (html) {
      console.log("Stage 2 succeeded");
      return res.type("html").send(html);
    }

    console.log("Stage 2 failed, trying Stage 3...");
    html = await extractMorss(targetUrl);
    if (html) {
      console.log("Stage 3 succeeded");
      return res.type("html").send(html);
    }

    return res.status(500).send("Extraction failed on all stages");
  } catch (err) {
    console.error("Route error:", err);
    return res.status(500).send("Server Error: " + err.message);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Proxy running on port " + PORT);
});
