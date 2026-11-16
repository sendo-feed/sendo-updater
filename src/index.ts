/**
 * 各自の fork が上流（sendo-feed）の main に遅れていたら、merge-upstream で取り込む。
 *
 * Cron Triggers で毎分動き、毎回 GitHub の今の状態（上流との差分）から判断する。手元に状態を持たないので、
 * 取りこぼしても次の分に追いつく。取り込んだ push で、各 fork の Workers Builds がデプロイする。
 * 決定は sendo の docs/decisions/deploy.md の 7。
 */

export interface Env {
  /** fine-grained PAT。各自の fork の Contents と Workflows の書き込みだけを与える */
  GITHUB_TOKEN: string;
  /** fork の持ち主（GitHub のユーザーか組織）。Cloudflare の画面の「変数」に入れる */
  GITHUB_OWNER?: string;
}

export interface Target {
  /** リポジトリの名前。fork も上流と同じ名前にする */
  name: string;
  /** この fork より先に、上流への追従とデプロイ（deployCheck のチェックの成功）を終えておく fork */
  after?: { name: string; deployCheck: string };
}

export const UPSTREAM_OWNER = "sendo-feed";

/** 上から順に調べる。after に挙げる fork は、それより上に置く。持っていない fork は飛ばす */
export const TARGETS: readonly Target[] = [
  { name: "sendo" },
  {
    name: "sendo-reader",
    // API を足したときなどに、reader が sendo より先に出て、まだない API を呼ばないようにする
    after: { name: "sendo", deployCheck: "Workers Builds: sendo" },
  },
  { name: "sendo-updater" },
];

const BRANCH = "main";

/** GitHub のユーザー名と組織名に使える形（URL のパスに入れるので、ほかの文字を通さない） */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** fork ごとの結果。何もしなければ null（ログに出さない） */
export type Outcome = { repo: string; message: string | null } | { repo: string; error: unknown };

export default {
  async scheduled(_controller, env) {
    if (!env.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN is not set");
    }
    const owner = env.GITHUB_OWNER?.trim() ?? "";
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error(`GITHUB_OWNER is not a GitHub user or organization name: "${owner}"`);
    }
    const outcomes = await updateForks(env.GITHUB_TOKEN, owner);
    const errors: unknown[] = [];
    for (const outcome of outcomes) {
      if ("error" in outcome) {
        errors.push(outcome.error);
      } else if (outcome.message !== null) {
        console.log(`${outcome.repo}: ${outcome.message}`);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, errors.map(String).join("\n"));
    }
  },
} satisfies ExportedHandler<Env>;

/** fork ごとの、上流からの遅れ（コミットの数）。fork がなければ "missing" */
type ForkState = number | "missing";

/** TARGETS を順に調べ、遅れている fork に上流を取り込む。1つが失敗しても、ほかの fork は調べる */
export async function updateForks(token: string, owner: string): Promise<Outcome[]> {
  const github = new GitHub(token);
  // 調べられなかった fork は入らない
  const states = new Map<string, ForkState>();
  const outcomes: Outcome[] = [];
  for (const target of TARGETS) {
    const repo = `${owner}/${target.name}`;
    try {
      const state = await github.behindBy(repo);
      states.set(target.name, state);
      const message =
        state === "missing" || state === 0
          ? null
          : await catchUp(github, owner, target, state, states);
      outcomes.push({ repo, message });
    } catch (error) {
      outcomes.push({ repo, error });
    }
  }
  if (TARGETS.every((target) => states.get(target.name) === "missing")) {
    // GITHUB_OWNER を間違えていると、何も取り込まないまま黙ってしまうので知らせる
    outcomes.push({
      repo: owner,
      error: new Error(`no forks of ${UPSTREAM_OWNER} repositories found under ${owner}`),
    });
  }
  return outcomes;
}

/** 遅れている fork に、取り込んでよければ上流を取り込む。何をしたかを返す */
async function catchUp(
  github: GitHub,
  owner: string,
  target: Target,
  behind: number,
  states: ReadonlyMap<string, ForkState>,
): Promise<string> {
  const lag = `${behind} commit(s) behind`;
  if (target.after !== undefined) {
    const before = states.get(target.after.name);
    const beforeRepo = `${owner}/${target.after.name}`;
    // 先に出す fork を持っていなければ、待たない
    if (before !== "missing") {
      if (before !== 0) {
        return `${lag}; waiting for ${beforeRepo} to catch up`;
      }
      if (!(await github.checkSucceeded(beforeRepo, target.after.deployCheck))) {
        return `${lag}; waiting for "${target.after.deployCheck}" to succeed on ${beforeRepo}`;
      }
    }
  }
  const mergeType = await github.mergeUpstream(`${owner}/${target.name}`);
  return `${lag}; merged upstream (${mergeType})`;
}

/** GitHub の API の失敗。状態コードで分けて扱う */
class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 使う GitHub の REST API。応答は使うところだけを型にする */
class GitHub {
  constructor(private readonly token: string) {}

  /** fork の main に、上流の main のコミットがいくつ足りないか。fork がなければ "missing" */
  async behindBy(repo: string): Promise<ForkState> {
    try {
      const compare = await this.get<{ ahead_by: number }>(
        `/repos/${repo}/compare/${BRANCH}...${UPSTREAM_OWNER}:${BRANCH}?per_page=1`,
      );
      return compare.ahead_by;
    } catch (error) {
      // リポジトリがない、または上流の fork ではない
      if (error instanceof GitHubError && error.status === 404) {
        return "missing";
      }
      throw error;
    }
  }

  /** main の先頭のコミットで、その名前のチェックの最新が成功しているか */
  async checkSucceeded(repo: string, name: string): Promise<boolean> {
    const { check_runs } = await this.get<{
      check_runs: { id: number; status: string; conclusion: string | null }[];
    }>(`/repos/${repo}/commits/${BRANCH}/check-runs?check_name=${encodeURIComponent(name)}`);
    const latest = check_runs.reduce<(typeof check_runs)[number] | undefined>(
      (newest, run) => (newest === undefined || run.id > newest.id ? run : newest),
      undefined,
    );
    return latest?.status === "completed" && latest.conclusion === "success";
  }

  /**
   * 上流の main を fork の main に取り込む（GitHub の「Sync fork」と同じ）。fork だけのコミットは残し、
   * 競合すれば上書きせずに失敗する（409）。取り込み方（merge、fast-forward、none）を返す
   */
  async mergeUpstream(repo: string): Promise<string> {
    const response = await this.request("POST", `/repos/${repo}/merge-upstream`, {
      branch: BRANCH,
    });
    const result = (await response.json()) as { merge_type?: string };
    return result.merge_type ?? "unknown";
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.request("GET", path);
    return (await response.json()) as T;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "sendo-updater",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`https://api.github.com${path}`, init);
    if (!response.ok) {
      // 本文は GitHub が返すエラーの説明で、トークンは含まない
      throw new GitHubError(
        response.status,
        `${method} ${path} failed (${response.status}): ${await response.text()}`,
      );
    }
    return response;
  }
}
