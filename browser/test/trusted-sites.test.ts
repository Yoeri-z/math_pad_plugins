import assert from "node:assert/strict";
import test from "node:test";
import {
  type TrustedSite,
  isTrustedSite,
  parseTrustedSites,
  siteFromUrl,
} from "../lib/trusted-sites.ts";

const OVERLEAF: TrustedSite = {
  hostname: "www.overleaf.com",
  pattern: "https://www.overleaf.com/*",
};

test("builds a site from a page URL", () => {
  const site = siteFromUrl("https://www.overleaf.com/project/abc123");

  assert.deepEqual(site, OVERLEAF);
});

test("omits the port from the match pattern", () => {
  const site = siteFromUrl("http://localhost:3000/notebook");

  assert.deepEqual(site, { hostname: "localhost", pattern: "http://localhost/*" });
});

test("ignores an invalid URL", () => {
  const site = siteFromUrl("not a url");

  assert.equal(site, undefined);
});

test("ignores a non-web URL", () => {
  const site = siteFromUrl("chrome-extension://abc123/popup.html");

  assert.equal(site, undefined);
});

test("ignores a malformed stored value", () => {
  const sites = parseTrustedSites("not a list");

  assert.deepEqual(sites, []);
});

test("drops invalid stored sites", () => {
  const sites = parseTrustedSites([
    OVERLEAF,
    { hostname: "", pattern: "nonsense" },
    "not a site",
  ]);

  assert.deepEqual(sites, [OVERLEAF]);
});

test("drops non-web stored patterns", () => {
  const sites = parseTrustedSites([
    { hostname: "overleaf.com", pattern: "javascript://overleaf.com/*" },
  ]);

  assert.deepEqual(sites, []);
});

test("deduplicates stored sites by pattern", () => {
  const sites = parseTrustedSites([OVERLEAF, { ...OVERLEAF }]);

  assert.deepEqual(sites, [OVERLEAF]);
});

test("recognizes a trusted site", () => {
  const trusted = isTrustedSite([OVERLEAF], OVERLEAF);

  assert.equal(trusted, true);
});

test("does not trust a different site", () => {
  const trusted = isTrustedSite([OVERLEAF], {
    hostname: "example.com",
    pattern: "https://example.com/*",
  });

  assert.equal(trusted, false);
});
