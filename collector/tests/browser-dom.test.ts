import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { BaytBrowser, SafetyStopError, classifyBulkExportSafetyResponse } from "../src/bayt.ts";
import { filterCatalogVersion } from "../src/windows-agent.ts";

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

test("attributes bulk-export safety responses only to Bayt searchCv routes", () => {
  assert.equal(classifyBulkExportSafetyResponse("https://px.ads.example/track", 429), null);
  assert.equal(classifyBulkExportSafetyResponse("https://www.bayt.com/favicon.ico", 429), null);
  assert.equal(classifyBulkExportSafetyResponse("https://www.bayt.com/v6/searchCv/123/downloadCV/export", 200), null);
  assert.deepEqual(
    classifyBulkExportSafetyResponse("https://www.bayt.com/v6/searchCv/123/downloadCV/export?token=secret", 429),
    { reason: "bayt_429", route: "downloadCV" },
  );
  assert.deepEqual(
    classifyBulkExportSafetyResponse("https://www.bayt.com/v6/searchCv/123/getActionToken?token=secret", 403),
    { reason: "bayt_403", route: "getActionToken" },
  );
});

test("extracts CV_ID, profile links, update date and avatar status from a listing", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const html = `<!doctype html><html><body>
    <input name="p" value="1"><span>of 2</span>
    <ul>
      <li>
        <input type="checkbox" name="10001">
        <div title="Last CV update date : 2026-08-20"></div>
        <img src="https://img.test/images/uploads/user_photos/01/10001.jpg">
        <a href="/en/employers/cv-search/profile/?icode=one">Candidate One</a>
      </li>
      <li>
        <input type="checkbox" name="10002">
        <div title="Last CV update date : 2026-08-21"></div>
        <img src="https://img.test/images/people/no-photo-large-m.png">
        <a href="/en/employers/cv-search/profile/?icode=two">Candidate Two</a>
      </li>
    </ul>
  </body></html>`;
  await context.route("https://www.bayt.com/en/employers/cv-search/listing/?searchId=test", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });
  const page = await context.newPage();
  await page.goto("https://www.bayt.com/en/employers/cv-search/listing/?searchId=test");
  const collector = BaytBrowser.fromTestContext(context, page);
  const candidates = await collector.listCandidates(1);
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((candidate) => ({
      cvId: candidate.cvId,
      lastCvUpdate: candidate.lastCvUpdate,
      avatarStatus: candidate.avatarStatus,
    })),
    [
      { cvId: "10001", lastCvUpdate: "2026-08-20", avatarStatus: "photo" },
      { cvId: "10002", lastCvUpdate: "2026-08-21", avatarStatus: "placeholder" },
    ],
  );
  await context.close();
  await browser.close();
});

test("restores the same saved search when Bayt returns to the search form before the next page", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  await context.route("https://www.bayt.com/en/employers/cv-search/?searchId=same-search", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<input placeholder="Search by title, skill, location, etc.">',
    });
  });
  await context.route("https://www.bayt.com/en/employers/cv-search/listing/**", async (route) => {
    const url = new URL(route.request().url());
    const pageNo = Number(url.searchParams.get("p") || "1");
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <form action="/en/employers/cv-search/listing/" method="get">
          <input type="hidden" name="searchId" value="same-search">
          <input name="p" value="${pageNo}">
        </form>
        <input type="checkbox" name="${10000 + pageNo}">
        <a href="/en/employers/cv-search/profile/?id=${pageNo}">Candidate ${pageNo}</a>
      </body></html>`,
    });
  });
  const page = await context.newPage();
  await page.goto("https://www.bayt.com/en/employers/cv-search/?searchId=same-search");
  const collector = BaytBrowser.fromTestContext(context, page);
  await collector.goToPage(2, "same-search");
  assert.equal(new URL(page.url()).searchParams.get("searchId"), "same-search");
  assert.equal(await page.locator('input[name="p"]').inputValue(), "2");
  assert.equal(await page.locator('input[type="checkbox"][name="10002"]').count(), 1);
  await context.close();
  await browser.close();
});

test("waits for new CV_IDs after Bayt updates the page input before its AJAX results", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  await context.route("https://www.bayt.com/en/employers/cv-search/listing/?searchId=same-search", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <input name="p" value="1">
        <ul><li><input type="checkbox" name="10001"><a href="/en/employers/cv-search/profile/?id=1">Candidate One</a></li></ul>
        <script>
          document.querySelector('input[name="p"]').addEventListener('keydown', (event) => {
            if (event.key === 'Enter') setTimeout(() => {
              document.querySelector('input[type="checkbox"]').name = '10002';
            }, 500);
          });
        </script>
      </body></html>`,
    });
  });
  const page = await context.newPage();
  await page.goto("https://www.bayt.com/en/employers/cv-search/listing/?searchId=same-search");
  const collector = BaytBrowser.fromTestContext(context, page);
  await collector.goToPage(2, "same-search");
  assert.equal(await page.locator('input[type="checkbox"]').getAttribute("name"), "10002");
  await context.close();
  await browser.close();
});

test("stops on a Cloudflare block page", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  await context.route("https://www.bayt.com/en/employers/cv-search/", async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "text/html",
      body: "<html><title>Attention Required! | Cloudflare</title><body>Sorry, you have been blocked</body></html>",
    });
  });
  const page = await context.newPage();
  const collector = BaytBrowser.fromTestContext(context, page);
  await assert.rejects(() => collector.assertLoggedIn(), SafetyStopError);
  await context.close();
  await browser.close();
});

test("interactive login keeps a challenge page open for manual clearance", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const visited: string[] = [];
  await context.route("https://www.bayt.com/", async (route) => {
    visited.push("home");
    await route.fulfill({
      status: 403,
      contentType: "text/html",
      body: "<html><title>Attention Required! | Cloudflare</title><body>Sorry, you have been blocked</body></html>",
    });
  });
  await context.route("https://www.bayt.com/en/employers/login/", async (route) => {
    visited.push("login");
    await route.fulfill({ status: 200, contentType: "text/html", body: '<input type="email"><input type="password">' });
  });
  await context.route("https://www.bayt.com/en/employers/dashboard/", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "Employer dashboard" });
  });
  await context.route("https://www.bayt.com/en/employers/cv-search/", async (route) => {
    visited.push("search");
    await route.fulfill({ status: 200, contentType: "text/html", body: '<input placeholder="Search by title, skill, location, etc.">' });
  });
  const page = await context.newPage();
  const collector = BaytBrowser.fromTestContext(context, page);
  const login = collector.loginInteractively(5_000);
  await page.waitForFunction(() => document.body.innerText.includes("Sorry, you have been blocked"));
  await page.setContent("Home cleared");
  await page.waitForURL("https://www.bayt.com/en/employers/login/");
  await page.goto("https://www.bayt.com/en/employers/dashboard/");
  await login;
  assert.equal(await page.locator('input[placeholder="Search by title, skill, location, etc."]').count(), 1);
  assert.deepEqual(visited, ["home", "login", "search"]);
  await context.close();
  await browser.close();
});

test("clicks login once when official Chrome has already filled saved credentials", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  let searchVisits = 0;
  await context.route("https://www.bayt.com/en/employers/login/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<form>
        <input name="LoginForm[username]" value="saved-user">
        <input name="LoginForm[password]" value="saved-password">
        <button name="submit" type="button" onclick="location.href='/en/employers/dashboard/'">Log in</button>
      </form>`,
    });
  });
  await context.route("https://www.bayt.com/en/employers/dashboard/", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "Employer dashboard" });
  });
  await context.route("https://www.bayt.com/en/employers/cv-search/", async (route) => {
    searchVisits += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<input placeholder="Search by title, skill, location, etc.">',
    });
  });
  const page = await context.newPage();
  const collector = BaytBrowser.fromTestContext(context, page);
  assert.equal(await collector.tryLoginWithSavedCredentials(), true);
  assert.equal(searchVisits, 1);
  assert.match(page.url(), /\/en\/employers\/cv-search\/$/);
  await context.close();
  await browser.close();
});

test("does not click or fill the login form when saved credentials are unavailable", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  await context.route("https://www.bayt.com/en/employers/login/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<form>
        <input name="LoginForm[username]">
        <input name="LoginForm[password]">
        <button name="submit" type="button" onclick="document.body.dataset.clicked='yes'">Log in</button>
      </form>`,
    });
  });
  const page = await context.newPage();
  const collector = BaytBrowser.fromTestContext(context, page);
  assert.equal(await collector.tryLoginWithSavedCredentials(), false);
  assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
  assert.equal(await page.locator('input[name="LoginForm[username]"]').inputValue(), "");
  assert.equal(await page.locator('input[name="LoginForm[password]"]').inputValue(), "");
  await context.close();
  await browser.close();
});

test("does not submit saved credentials through a CAPTCHA page", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  await context.route("https://www.bayt.com/en/employers/login/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<p>Verify you are human</p>
        <input name="LoginForm[username]" value="saved-user">
        <input name="LoginForm[password]" value="saved-password">
        <button name="submit" type="button" onclick="document.body.dataset.clicked='yes'">Log in</button>`,
    });
  });
  const page = await context.newPage();
  const collector = BaytBrowser.fromTestContext(context, page);
  await assert.rejects(() => collector.tryLoginWithSavedCredentials(), SafetyStopError);
  assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
  await context.close();
  await browser.close();
});

test("opens the saved recent-search control when Bayt uses the two-stage search flow", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  await context.route("https://www.bayt.com/en/employers/cv-search/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/listing/")) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<p>5M+ CVs matching your search</p><input name="p" value="1"><input type="checkbox" name="10001"><a href="/en/employers/cv-search/profile/?id=1">One</a>',
      });
      return;
    }
    if (url.searchParams.has("searchId")) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<button onclick="location.href=\'/en/employers/cv-search/listing/?searchId=new-search\'">Software Engineer (1 CV)</button>',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<input placeholder="Search by title, skill, location, etc."><button onclick="location.href=\'/en/employers/cv-search/?searchId=new-search\'">Search CVs</button>',
    });
  });
  const page = await context.newPage();
  const collector = BaytBrowser.fromTestContext(context, page);
  const state = await collector.createSearch("Software Engineer", false);
  assert.equal(state.searchId, "new-search");
  assert.equal(state.displayedCount, 5_000_000);
  assert.match(state.listingUrl, /\/cv-search\/listing\//);
  await context.close();
  await browser.close();
});

test("discovers supported and unsupported Filter controls from the logged-in listing", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = `<!doctype html><html><body>
    <input name="p" value="1"><span>of 2</span>
    <div class="filters">
      <input class="accordion-toggle" type="checkbox" id="activity">
      <label class="accordion-title" for="activity">CV activity</label>
      <div class="accordion-content">
        <input class="accordion-toggle" type="checkbox" id="updated">
        <label class="accordion-title" for="updated">Last updated</label>
        <div class="accordion-content">
          <label><input type="radio" name="updated" value="all">All (10,000+)</label>
          <label><input type="radio" name="updated" value="six-months">Within last 6 months (8,321)</label>
          <label><input type="radio" name="updated" value="year">Within last year (9,552)</label>
        </div>
        <input class="accordion-toggle" type="checkbox" id="unstable">
        <label class="accordion-title" for="unstable">Unstable field</label>
        <div class="accordion-content"><span>Custom non-form control</span></div>
      </div>
    </div>
    <a data-sortid="relevance">Relevance</a>
    <a data-sortid="last-updated">Last updated</a>
    <input class="accordion-toggle" type="checkbox" id="tips">
    <label class="accordion-title" for="tips">Search tips Search tips</label>
    <div class="accordion-content"><span>Not a Filter</span></div>
    <input type="checkbox" name="10001"><a href="/en/employers/cv-search/profile/?id=1">One</a>
  </body></html>`;
  await context.route("https://www.bayt.com/en/employers/cv-search/listing/?searchId=test", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });
  await page.goto("https://www.bayt.com/en/employers/cv-search/listing/?searchId=test");
  const collector = BaytBrowser.fromTestContext(context, page);
  const catalog = await collector.discoverFilterCatalog();
  assert.deepEqual(catalog.filters.map((item) => ({ label: item.label, supported: item.supported, controlType: item.controlType })), [
    { label: "Last updated", supported: true, controlType: "single" },
    { label: "Unstable field", supported: false, controlType: "unsupported" },
  ]);
  assert.deepEqual(catalog.filters[0].options, [
    { key: "within-last-6-months", label: "Within last 6 months" },
    { key: "within-last-year", label: "Within last year" },
  ]);
  assert.deepEqual(catalog.sorts, [
    { key: "relevance", label: "Relevance" },
    { key: "last-updated", label: "Last updated" },
  ]);
  assert.equal(await page.locator("#activity").isChecked(), false);
  assert.equal(await page.locator("#updated").isChecked(), false);
  assert.equal(await page.locator("#unstable").isChecked(), false);
  assert.match(filterCatalogVersion(catalog), /^bayt-[a-f0-9]{16}$/);
  await context.close();
  await browser.close();
});

test("resets Filter discovery to a canonical search when strict versions are required", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route("https://www.bayt.com/en/employers/cv-search/listing/?searchId=job-specific", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <input name="p" value="1">
        <input class="accordion-toggle" type="checkbox" id="updated">
        <label class="accordion-title" for="updated">Last updated</label>
        <div class="accordion-content">
          <label><input type="radio" name="updated">Within last 6 months</label>
        </div>
        <input type="checkbox" name="10001"><a href="/en/employers/cv-search/profile/?id=1">One</a>
      </body></html>`,
    });
  });
  await page.goto("https://www.bayt.com/en/employers/cv-search/listing/?searchId=job-specific");
  const collector = BaytBrowser.fromTestContext(context, page);
  let canonicalSearches = 0;
  (collector as unknown as { createSearch: (query: string, applyFilter: boolean) => Promise<unknown> }).createSearch = async (query, applyFilter) => {
    assert.equal(query, "Software Engineer");
    assert.equal(applyFilter, false);
    canonicalSearches += 1;
    return {};
  };
  const catalog = await collector.discoverFilterCatalog({ resetToCanonicalSearch: true });
  assert.equal(canonicalSearches, 1);
  assert.equal(catalog.filters[0]?.key, "last-updated");
  await context.close();
  await browser.close();
});

test("waits for an asynchronously hydrated Filter option", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<div id="filter"></div>');
  const collector = BaytBrowser.fromTestContext(context, page) as unknown as {
    findFilterOption: (root: import("playwright").Locator, expectedLabel: string) => Promise<import("playwright").Locator | null>;
    filterOptionIsSelected: (root: import("playwright").Locator, expectedLabel: string) => Promise<boolean>;
  };
  const root = page.locator("#filter");
  const pending = collector.findFilterOption(root, "Within last 6 months");
  await page.waitForTimeout(300);
  await root.evaluate((element) => {
    element.innerHTML = '<label><input type="radio" value="4" checked>Within last 6 months (10,000+)</label>';
  });
  const option = await pending;
  assert.ok(option);
  assert.match(await option.innerText(), /Within last 6 months/);
  await root.evaluate((element) => { (element as HTMLElement).style.display = "none"; });
  assert.equal(await collector.filterOptionIsSelected(root, "Within last 6 months"), true);
  await context.close();
  await browser.close();
});

test("waits for an asynchronously hydrated Filter definition", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`
    <input class="accordion-toggle" type="checkbox" id="tags" checked>
    <label class="accordion-title" for="tags">Tags on CV</label>
    <div class="accordion-content"><span class="placeholder"></span></div>
  `);
  const collector = BaytBrowser.fromTestContext(context, page) as unknown as {
    readAccordionFilterDefinition: (
      label: string,
      control: { title: import("playwright").Locator; toggle: import("playwright").Locator; content: import("playwright").Locator },
    ) => Promise<{ supported: boolean; controlType: string; options: Array<{ key: string; label: string }> }>;
  };
  const control = {
    title: page.locator('label[for="tags"]'),
    toggle: page.locator("#tags"),
    content: page.locator(".accordion-content"),
  };
  const pending = collector.readAccordionFilterDefinition("Tags on CV", control);
  await page.waitForTimeout(1_500);
  await control.content.evaluate((element) => {
    element.innerHTML = '<label><input type="checkbox">Contact Revealed</label><label><input type="checkbox">CVs Without Tags</label>';
  });
  const definition = await pending;
  assert.equal(definition.supported, true);
  assert.equal(definition.controlType, "multi");
  assert.deepEqual(definition.options, [
    { key: "contact-revealed", label: "Contact Revealed" },
    { key: "cvs-without-tags", label: "CVs Without Tags" },
  ]);
  await context.close();
  await browser.close();
});

test("opens the hidden sort menu before selecting an option", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route("https://www.bayt.com/en/employers/cv-search/listing/?searchId=sort-test", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <input type="checkbox" name="10001">
        <div class="popover-owner">
          <button onclick="document.querySelector('.popover').style.display='block'">Relevancy</button>
          <div class="popover" style="display:none">
            <a data-sortid="cvRelevancy" disabled="true">Relevancy</a>
            <a data-sortid="lastActivity" onclick="document.body.dataset.sort='lastActivity'">Last updated</a>
          </div>
        </div>
      </body></html>`,
    });
  });
  await page.goto("https://www.bayt.com/en/employers/cv-search/listing/?searchId=sort-test");
  const collector = BaytBrowser.fromTestContext(context, page) as unknown as {
    applySortOption: (sort: { key: string; label: string }) => Promise<void>;
  };
  await collector.applySortOption({ key: "lastactivity", label: "Last updated" });
  assert.equal(await page.locator("body").getAttribute("data-sort"), "lastActivity");
  await context.close();
  await browser.close();
});

test("waits for the bulk Download CV action bar after selecting candidates", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<div id="bulkActionsBar"></div><input type="checkbox" name="10001">');
  const collector = BaytBrowser.fromTestContext(context, page) as unknown as {
    findBulkDownloadControl: () => Promise<import("playwright").Locator | null>;
  };
  const pending = collector.findBulkDownloadControl();
  await page.waitForTimeout(200);
  await page.locator("#bulkActionsBar").evaluate((bar) => {
    bar.innerHTML = '<a href="#"><i data-text="download "></i>Download CV</a>';
  });
  const control = await pending;
  assert.ok(control);
  assert.equal((await control.innerText()).trim(), "Download CV");
  await context.close();
  await browser.close();
});

test("clears selected candidates even when Bayt has moved their checkboxes offscreen", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`
    <div style="height: 2000px"></div>
    <input type="checkbox" name="10001" checked style="display:none">
    <input type="checkbox" name="10002" checked style="position:absolute;top:2400px">
  `);
  const collector = BaytBrowser.fromTestContext(context, page) as unknown as {
    clearCandidateSelection: () => Promise<void>;
  };
  await collector.clearCandidateSelection();
  assert.deepEqual(
    await page.locator('input[type="checkbox"][name]').evaluateAll((boxes) =>
      boxes.map((box) => (box as HTMLInputElement).checked),
    ),
    [false, false],
  );
  await context.close();
  await browser.close();
});

test("captures the confirmed Bayt export request and downloads it in the same browser session", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await context.route("https://www.bayt.com/test-export", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <input type="checkbox" name="10001">
        <div id="bulkActionsBar"><a href="#" onclick="document.querySelector('.modal').style.display='block';return false"><i data-text="download "></i>Download CV</a></div>
        <div class="modal" role="dialog" style="display:none">
          <label><input type="radio" name="format" value="xls">Microsoft Excel (XLS file format)</label>
          <label><input type="radio" name="format" value="pdf">Adobe Acrobat (PDF file format)</label>
          <button onclick="fetch('/v6/searchCv/test/downloadCV/export',{method:'POST',headers:{'X-CSRF-Token':'fixture'},body:'format=xls'})">Download without revealing</button>
        </div>
      </body></html>`,
    });
  });
  await context.route("https://www.bayt.com/v6/searchCv/test/downloadCV/export", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "application/vnd.ms-excel",
        "Content-Disposition": 'attachment; filename="fixture.xls"',
      },
      body: "fixture-xls",
    });
  });
  await page.goto("https://www.bayt.com/test-export");
  const collector = BaytBrowser.fromTestContext(context, page);
  const download = await collector.exportBulk(["10001"], "xls");
  assert.equal(download.suggestedFilename(), "fixture.xls");
  assert.equal(await download.failure(), null);
  await context.close();
  await browser.close();
});

test("stops immediately when Bayt reports unusually high account search activity", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body>
    <input type="checkbox" name="10001">
    <div id="bulkActionsBar"><a href="#" onclick="document.querySelector('.modal').style.display='block';return false"><i data-text="download "></i>Download CV</a></div>
    <div class="modal" role="dialog" style="display:none">
      <label><input type="radio" name="format" value="xls">Microsoft Excel (XLS file format)</label>
      <button onclick="this.parentElement.innerHTML='Hold on a moment! We are currently seeing unusually high search activity from your account. Please try again in a few minutes.'">Download without revealing</button>
    </div>
  </body></html>`);
  const collector = BaytBrowser.fromTestContext(context, page);
  await assert.rejects(
    () => collector.exportBulk(["10001"], "xls"),
    (error: unknown) => error instanceof SafetyStopError && error.reason === "rate_limited",
  );
  await context.close();
  await browser.close();
});
