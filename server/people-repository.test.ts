import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createImportedPerson, PeopleRepository } from "./people-repository.ts";

test("分批导入按CV_ID增量合并且新记录覆盖同ID旧记录", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayt-imported-people-"));
  const importedPeoplePath = path.join(directory, "imported", "people.json");
  const repository = new PeopleRepository({ includeImported: true });
  Object.defineProperty(repository, "importedPeoplePath", { value: importedPeoplePath });

  const first = createImportedPerson("10001", "First", { Status: "Engineer" }, "first.pdf", "2026-08-24T00:00:00Z");
  const second = createImportedPerson("10002", "Second", { Status: "Engineer" }, "second.pdf", "2026-08-24T00:01:00Z");
  const refreshedFirst = createImportedPerson("10001", "First Updated", { Status: "Senior Engineer" }, "first-new.pdf", "2026-08-24T00:02:00Z");

  repository.saveImportedPeople([first]);
  repository.saveImportedPeople([second, refreshedFirst]);

  const persisted = JSON.parse(fs.readFileSync(importedPeoplePath, "utf8")) as Array<{ cvId: string; displayName: string }>;
  assert.deepEqual(persisted.map((person) => person.cvId), ["10001", "10002"]);
  assert.equal(persisted[0].displayName, "First Updated");
  assert.equal(fs.statSync(importedPeoplePath).mode & 0o777, 0o600);

  fs.rmSync(directory, { recursive: true, force: true });
});
