import { afterEach, describe, expect, test, vi } from "vitest";
import worker, { type Outcome, updateForks } from "../src/index";

const OWNER = "someone";
const SENDO = `${OWNER}/sendo`;
const READER = `${OWNER}/sendo-reader`;
const UPDATER = `${OWNER}/sendo-updater`;
const TOKEN = "token-value";

interface FakeCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

interface FakeFork {
  /** 上流の main より何コミット遅れているか */
  behind: number;
  /** main の先頭のコミットのチェック */
  checks?: FakeCheck[];
  /** compare がこの状態コードで失敗する */
  compareStatus?: number;
  /** merge-upstream がこの状態コードで失敗する */
  mergeStatus?: number;
}

const deployed: FakeCheck = {
  id: 1,
  name: "Workers Builds: sendo",
  status: "completed",
  conclusion: "success",
};

/** GitHub の REST API の代わり。forks にない fork は、ないものとして 404 を返す */
function fakeGitHub(forks: Record<string, FakeFork>) {
  const requests: { method: string; path: string; init: RequestInit }[] = [];
  const merged: string[] = [];
  const notFound = () => new Response('{"message":"Not Found"}', { status: 404 });

  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    requests.push({ method, path: url.pathname + url.search, init });
    const route = (pattern: RegExp) => url.pathname.match(pattern)?.[1];

    let repo = route(/^\/repos\/([^/]+\/[^/]+)\/compare\/main\.\.\.sendo-feed:main$/);
    if (repo !== undefined) {
      const fork = forks[repo];
      if (fork === undefined) return notFound();
      if (fork.compareStatus !== undefined) {
        return new Response('{"message":"Server Error"}', { status: fork.compareStatus });
      }
      return Response.json({ ahead_by: fork.behind });
    }
    repo = route(/^\/repos\/([^/]+\/[^/]+)\/merge-upstream$/);
    if (repo !== undefined && method === "POST") {
      const fork = forks[repo];
      if (fork === undefined) return notFound();
      if (fork.mergeStatus !== undefined) {
        return new Response('{"message":"There are merge conflicts"}', {
          status: fork.mergeStatus,
        });
      }
      merged.push(repo);
      return Response.json({ merge_type: "merge", base_branch: "sendo-feed:main" });
    }
    repo = route(/^\/repos\/([^/]+\/[^/]+)\/commits\/main\/check-runs$/);
    if (repo !== undefined) {
      const name = url.searchParams.get("check_name");
      return Response.json({
        check_runs: (forks[repo]?.checks ?? []).filter((c) => c.name === name),
      });
    }
    return notFound();
  });
  return { requests, merged };
}

function messages(outcomes: Outcome[]): Record<string, string | null> {
  return Object.fromEntries(
    outcomes.map((o) => [o.repo, "error" in o ? `error: ${String(o.error)}` : o.message]),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("updateForks", () => {
  test("どれも追いついていれば、差分を見るだけで何も取り込まない", async () => {
    const github = fakeGitHub({
      [SENDO]: { behind: 0 },
      [READER]: { behind: 0 },
      [UPDATER]: { behind: 0 },
    });
    const outcomes = await updateForks(TOKEN, OWNER);

    expect(messages(outcomes)).toEqual({ [SENDO]: null, [READER]: null, [UPDATER]: null });
    expect(github.merged).toEqual([]);
    expect(github.requests.map((r) => r.path)).toEqual([
      `/repos/${SENDO}/compare/main...sendo-feed:main?per_page=1`,
      `/repos/${READER}/compare/main...sendo-feed:main?per_page=1`,
      `/repos/${UPDATER}/compare/main...sendo-feed:main?per_page=1`,
    ]);
  });

  test("遅れていれば、merge-upstream で main に取り込む", async () => {
    const github = fakeGitHub({
      [SENDO]: { behind: 2 },
      [READER]: { behind: 0 },
      [UPDATER]: { behind: 1 },
    });
    const outcomes = await updateForks(TOKEN, OWNER);

    expect(messages(outcomes)).toEqual({
      [SENDO]: "2 commit(s) behind; merged upstream (merge)",
      [READER]: null,
      [UPDATER]: "1 commit(s) behind; merged upstream (merge)",
    });
    expect(github.merged).toEqual([SENDO, UPDATER]);

    const merge = github.requests.find((r) => r.method === "POST");
    expect(merge?.path).toBe(`/repos/${SENDO}/merge-upstream`);
    expect(new Headers(merge?.init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(merge?.init.body))).toEqual({ branch: "main" });
  });

  test("競合して取り込めなければ、その fork を失敗にして、ほかは続ける", async () => {
    const github = fakeGitHub({
      [SENDO]: { behind: 0 },
      [READER]: { behind: 0 },
      [UPDATER]: { behind: 1, mergeStatus: 409 },
    });
    const outcomes = await updateForks(TOKEN, OWNER);

    expect(messages(outcomes)[UPDATER]).toBe(
      `error: Error: POST /repos/${UPDATER}/merge-upstream failed (409): {"message":"There are merge conflicts"}`,
    );
    expect(github.merged).toEqual([]);
  });

  test("持っていない fork は飛ばす", async () => {
    const github = fakeGitHub({ [SENDO]: { behind: 1 }, [UPDATER]: { behind: 0 } });
    const outcomes = await updateForks(TOKEN, OWNER);

    expect(messages(outcomes)[READER]).toBeNull();
    expect(github.merged).toEqual([SENDO]);
  });

  test("どの fork も見つからなければ、持ち主の名前の間違いとして失敗にする", async () => {
    fakeGitHub({});
    const outcomes = await updateForks(TOKEN, OWNER);

    expect(messages(outcomes)[OWNER]).toBe(
      `error: Error: no forks of sendo-feed repositories found under ${OWNER}`,
    );
  });

  describe("reader は sendo のあとに出す", () => {
    test("sendo も遅れていれば、sendo だけを取り込み、reader は待つ", async () => {
      const github = fakeGitHub({
        [SENDO]: { behind: 1 },
        [READER]: { behind: 3 },
        [UPDATER]: { behind: 0 },
      });
      const outcomes = await updateForks(TOKEN, OWNER);

      expect(messages(outcomes)[READER]).toBe(
        `3 commit(s) behind; waiting for ${SENDO} to catch up`,
      );
      expect(github.merged).toEqual([SENDO]);
    });

    test("sendo のデプロイが終わっていなければ待つ", async () => {
      const github = fakeGitHub({
        [SENDO]: { behind: 0, checks: [{ ...deployed, status: "in_progress", conclusion: null }] },
        [READER]: { behind: 3 },
        [UPDATER]: { behind: 0 },
      });
      const outcomes = await updateForks(TOKEN, OWNER);

      expect(messages(outcomes)[READER]).toBe(
        `3 commit(s) behind; waiting for "Workers Builds: sendo" to succeed on ${SENDO}`,
      );
      expect(github.merged).toEqual([]);
    });

    test("sendo のデプロイが失敗していれば待つ", async () => {
      const github = fakeGitHub({
        [SENDO]: { behind: 0, checks: [{ ...deployed, conclusion: "failure" }] },
        [READER]: { behind: 3 },
        [UPDATER]: { behind: 0 },
      });
      await updateForks(TOKEN, OWNER);
      expect(github.merged).toEqual([]);
    });

    test("sendo のデプロイのチェックがまだなければ待つ", async () => {
      const github = fakeGitHub({
        [SENDO]: { behind: 0 },
        [READER]: { behind: 3 },
        [UPDATER]: { behind: 0 },
      });
      await updateForks(TOKEN, OWNER);
      expect(github.merged).toEqual([]);
    });

    test("sendo が追いついて、デプロイが成功していれば取り込む", async () => {
      const github = fakeGitHub({
        [SENDO]: { behind: 0, checks: [deployed] },
        [READER]: { behind: 3 },
        [UPDATER]: { behind: 0 },
      });
      const outcomes = await updateForks(TOKEN, OWNER);

      expect(messages(outcomes)[READER]).toBe("3 commit(s) behind; merged upstream (merge)");
      expect(github.merged).toEqual([READER]);
    });

    test("デプロイをやり直したときは、一番新しいチェックを見る", async () => {
      const github = fakeGitHub({
        [SENDO]: {
          behind: 0,
          checks: [
            { ...deployed, id: 2, conclusion: "failure" },
            { ...deployed, id: 3 },
          ],
        },
        [READER]: { behind: 1 },
        [UPDATER]: { behind: 0 },
      });
      await updateForks(TOKEN, OWNER);
      expect(github.merged).toEqual([READER]);
    });

    test("sendo の fork を持っていなければ、待たずに取り込む", async () => {
      const github = fakeGitHub({ [READER]: { behind: 2 }, [UPDATER]: { behind: 0 } });
      await updateForks(TOKEN, OWNER);
      expect(github.merged).toEqual([READER]);
    });

    test("sendo の状態がわからなければ、reader は待つ", async () => {
      const github = fakeGitHub({
        [SENDO]: { behind: 0, compareStatus: 502 },
        [READER]: { behind: 3 },
        [UPDATER]: { behind: 0 },
      });
      const outcomes = await updateForks(TOKEN, OWNER);

      expect(messages(outcomes)).toEqual({
        [SENDO]: `error: Error: GET /repos/${SENDO}/compare/main...sendo-feed:main?per_page=1 failed (502): {"message":"Server Error"}`,
        [READER]: `3 commit(s) behind; waiting for ${SENDO} to catch up`,
        [UPDATER]: null,
      });
      expect(github.merged).toEqual([]);
    });
  });
});

describe("scheduled", () => {
  const controller: ScheduledController = {
    cron: "* * * * *",
    scheduledTime: Date.parse("2026-11-16T12:00:00Z"),
    noRetry() {},
  };

  test("取り込めなかった fork があれば、ほかを調べたうえで失敗する", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const github = fakeGitHub({
      [SENDO]: { behind: 0, compareStatus: 500 },
      [READER]: { behind: 0 },
      [UPDATER]: { behind: 0 },
    });
    await expect(
      worker.scheduled(controller, { GITHUB_TOKEN: TOKEN, GITHUB_OWNER: OWNER }),
    ).rejects.toThrow("failed (500)");
    expect(github.requests.map((r) => r.path)).toContain(
      `/repos/${UPDATER}/compare/main...sendo-feed:main?per_page=1`,
    );
  });

  test("トークンがなければ、何も問い合わせずに失敗する", async () => {
    const github = fakeGitHub({});
    await expect(
      worker.scheduled(controller, { GITHUB_TOKEN: "", GITHUB_OWNER: OWNER }),
    ).rejects.toThrow("GITHUB_TOKEN is not set");
    expect(github.requests).toEqual([]);
  });

  test.each([undefined, "", "some/one", "../repos", "a".repeat(40)])(
    "持ち主の名前が %s なら、何も問い合わせずに失敗する",
    async (owner) => {
      const github = fakeGitHub({});
      const env =
        owner === undefined
          ? { GITHUB_TOKEN: TOKEN }
          : { GITHUB_TOKEN: TOKEN, GITHUB_OWNER: owner };
      await expect(worker.scheduled(controller, env)).rejects.toThrow("GITHUB_OWNER is not");
      expect(github.requests).toEqual([]);
    },
  );

  test("持ち主の名前の前後の空白は無視する", async () => {
    const github = fakeGitHub({ [SENDO]: { behind: 0 } });
    await worker.scheduled(controller, { GITHUB_TOKEN: TOKEN, GITHUB_OWNER: ` ${OWNER} ` });
    expect(github.requests[0]?.path).toBe(
      `/repos/${SENDO}/compare/main...sendo-feed:main?per_page=1`,
    );
  });
});
