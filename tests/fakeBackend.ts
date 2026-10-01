/*
 * A fake Supabase for the headless tests: GoTrue plus PostgREST, with row-level
 * security actually applied.
 *
 * The point is not to re-implement Supabase. It is to make the tests fail in the
 * same way production does when something is wrong: an anonymous write is
 * refused with 42501, a non-admin write is refused with 42501, a missing table is
 * reported as PGRST205, and a write that row-level security filtered out comes
 * back as an empty array rather than as a success. A stub that is more
 * forgiving than the real thing would let a broken panel pass.
 */
import type {
  AssistantPolicyRow,
  LanguageRow,
  SystemStateRow,
  UserAppSnapshot,
  VoiceRow
} from "../src/types.ts";

const NOW = "2026-09-30T12:00:00.000Z";

export interface FakeUser {
  email: string;
  app_metadata: Record<string, unknown>;
}

export interface FakeDb {
  /** Table names that "exist". A missing one answers PGRST205. */
  tables: Set<string>;
  languages: LanguageRow[];
  voices: VoiceRow[];
  systemState: SystemStateRow;
  assistantPolicy: AssistantPolicyRow | null;
  /** access_token -> the user it belongs to. */
  tokens: Map<string, FakeUser>;
  password: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  token: string;
  body: string | null;
}

export interface FakeBackend {
  db: FakeDb;
  requests: RecordedRequest[];
  fetchStub: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  snapshot: () => UserAppSnapshot;
  /** Set to a message to make every request fail the way an unreachable host does. */
  offline: string | null;
}

export function seedDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    tables: new Set(["jarvis_languages", "jarvis_language_voices", "jarvis_system_state", "jarvis_assistant_policy"]),
    languages: [
      language("english", "en", "English", true, true),
      language("hindi", "hi", "Hindi", true, false),
      language("arabic", "ar", "Arabic", true, false)
    ],
    voices: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        language_id: "english",
        language_code: "en",
        gender: "male",
        voice_id: "en-us-x-sfg#1",
        voice_name: "English (United States) - Android Studio",
        enabled: true,
        is_primary: true,
        created_at: NOW,
        updated_at: NOW
      }
    ],
    systemState: { id: "default", jarvis_enabled: true, created_at: NOW, updated_at: NOW },
    assistantPolicy: {
      id: "default",
      sms_assistant_enabled: true,
      announce_incoming: true,
      reply_enabled: true,
      confirmation_required: true,
      attribution_enabled: true,
      attribution_text: "- Hamzah ka Assistant",
      body_timeout_ms: 20000,
      confirmation_timeout_ms: 30000,
      call_assistant_enabled: true,
      announce_incoming_calls: true,
      answer_enabled: true,
      confirmation_required_before_answering: true,
      auto_answer: false,
      auto_reject: false,
      decision_timeout_ms: 25000,
      created_at: NOW,
      updated_at: NOW
    },
    tokens: new Map<string, FakeUser>([
      ["admin-access-token", { email: "admin@jarvis.app", app_metadata: { role: "admin" } }],
      ["user-access-token", { email: "user@jarvis.app", app_metadata: {} }]
    ]),
    password: "correct-horse",
    ...overrides
  };
}

function language(id: string, code: string, name: string, enabled: boolean, isDefault: boolean): LanguageRow {
  return {
    id,
    language_code: code,
    display_name: name,
    response_tag: code,
    recognition_tag: code,
    script_rule: `- Reply in ${name}.`,
    enabled,
    is_default: isDefault,
    created_at: NOW,
    updated_at: NOW
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rowsOf(db: FakeDb, table: string): Record<string, unknown>[] {
  switch (table) {
    case "jarvis_languages":
      return db.languages as unknown as Record<string, unknown>[];
    case "jarvis_language_voices":
      return db.voices as unknown as Record<string, unknown>[];
    case "jarvis_system_state":
      return [db.systemState as unknown as Record<string, unknown>];
    case "jarvis_assistant_policy":
      return db.assistantPolicy ? [db.assistantPolicy as unknown as Record<string, unknown>] : [];
    default:
      return [];
  }
}

export function createFakeBackend(options: { db?: FakeDb; healthStatus?: number } = {}): FakeBackend {
  const db = options.db ?? seedDb();
  const requests: RecordedRequest[] = [];

  const snapshot = (): UserAppSnapshot => {
    const languages = db.languages
      .filter((row) => row.enabled)
      .map((row) => ({ ...row }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Set(languages.map((row) => row.id));
    return {
      version: 1,
      languages,
      voices: db.voices
        .filter((row) => row.enabled && ids.has(row.language_id))
        .map((row) => ({
          language_id: row.language_id,
          language_code: row.language_code,
          gender: row.gender,
          voice_id: row.voice_id,
          voice_name: row.voice_name,
          is_primary: row.is_primary
        })),
      jarvisEnabled: db.systemState.jarvis_enabled,
      systemStateUpdatedAt: db.systemState.updated_at,
      smsPolicy: db.assistantPolicy
        ? {
            sms_assistant_enabled: db.assistantPolicy.sms_assistant_enabled,
            announce_incoming: db.assistantPolicy.announce_incoming,
            reply_enabled: db.assistantPolicy.reply_enabled,
            confirmation_required: db.assistantPolicy.confirmation_required,
            attribution_enabled: db.assistantPolicy.attribution_enabled,
            attribution_text: db.assistantPolicy.attribution_text,
            body_timeout_ms: db.assistantPolicy.body_timeout_ms,
            confirmation_timeout_ms: db.assistantPolicy.confirmation_timeout_ms
          }
        : null,
      callPolicy: db.assistantPolicy
        ? {
            call_assistant_enabled: db.assistantPolicy.call_assistant_enabled,
            announce_incoming: db.assistantPolicy.announce_incoming_calls,
            answer_enabled: db.assistantPolicy.answer_enabled,
            confirmation_required_before_answering: db.assistantPolicy.confirmation_required_before_answering,
            auto_answer: db.assistantPolicy.auto_answer,
            auto_reject: db.assistantPolicy.auto_reject,
            decision_timeout_ms: db.assistantPolicy.decision_timeout_ms
          }
        : null
    };
  };

  /* Mutable switches the tests flip after the page has already been mounted. */
  const control = { offline: null as string | null };

  const fetchStub = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const authorization = headers.get("authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    const role: "admin" | "user" | "anon" = db.tokens.has(token)
      ? (db.tokens.get(token)!.app_metadata.role as string) === "admin"
        ? "admin"
        : "user"
      : "anon";
    requests.push({
      method,
      path: url.pathname + url.search,
      token,
      body: typeof init.body === "string" ? init.body : null
    });
    if (control.offline) throw new TypeError(control.offline);

    /* ------------------------------------------------------------- GoTrue ---- */

    if (url.pathname.endsWith("/auth/v1/token")) {
      const body = JSON.parse((init.body as string) ?? "{}") as Record<string, string>;
      if (body.grant_type === "refresh_token") {
        const refresh = (body.refresh_token ?? "").replace(/^refresh:/, "");
        if (refresh !== "admin-refresh-token" && refresh !== "user-refresh-token") {
          return json({ error: "invalid_grant", error_description: "Invalid Refresh Token" }, 400);
        }
        const user = refresh === "admin-refresh-token" ? "admin" : "user";
        return json(session(db, user, "admin-refresh-token"));
      }
      if (body.password === db.password) return json(session(db, "admin", "admin-refresh-token"));
      return json({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);
    }

    if (url.pathname.endsWith("/auth/v1/user")) {
      const user = db.tokens.get(token);
      if (!user) return json({ msg: "invalid JWT: unable to parse or verify signature" }, 401);
      return json(user);
    }

    if (url.pathname.endsWith("/auth/v1/logout")) return new Response("", { status: 204 });

    if (url.pathname.includes("/auth/v1/authorize")) {
      return new Response(JSON.stringify({ error: "unsupported_in_test", error_description: "redirect stubbed" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }

    /* ----------------------------------------------------------- Functions ---- */

    if (url.pathname.endsWith("/functions/v1/jarvis-health")) {
      if (options.healthStatus && options.healthStatus !== 200) {
        return json({ message: "gateway unavailable" }, options.healthStatus);
      }
      return json({
        status: "ok",
        provider: "gemini",
        chatModel: "gemini-3.8-flash",
        visionModel: "gemini-3.8-flash",
        searchProvider: "wikipedia",
        providers: [{ name: "gemini", configured: true, models: ["gemini-3.8-flash"] }]
      });
    }

    if (url.pathname.endsWith("/functions/v1/jarvis-languages")) return json(snapshot());

    /* ------------------------------------------------------------ PostgREST ---- */

    if (url.pathname.includes("/rest/v1/")) {
      const table = url.pathname.split("/rest/v1/")[1].split("?")[0];
      if (!db.tables.has(table)) {
        return json(
          {
            code: "PGRST205",
            details: null,
            hint: `Perhaps you meant the table 'public.jarvis_some_other_table'`,
            message: `Could not find the table 'public.${table}' in the schema cache`
          },
          404
        );
      }

      const writable = method !== "GET" && method !== "HEAD";
      if (writable && role !== "admin") {
        /* Exactly what the deployed project answers for an unprivileged insert. */
        return json(
          {
            code: "42501",
            details: null,
            hint: null,
            message: `new row violates row-level security policy for table "${table}"`
          },
          writable ? 401 : 200
        );
      }

      let rows = rowsOf(db, table);
      for (const [key, raw] of url.searchParams) {
        const match = /^(eq|neq)\.(.*)$/.exec(raw);
        if (!match) continue;
        const [, operator, wanted] = match;
        rows = rows.filter((row) =>
          operator === "eq" ? String(row[key]) === wanted : String(row[key]) !== wanted
        );
      }
      const order = url.searchParams.get("order");
      if (order) {
        const match = /^(.+)\.(asc|desc)$/.exec(order);
        if (match) {
          const [, key, direction] = match;
          rows = rows
            .slice()
            .sort(
              (a, b) =>
                String(a[key] ?? "").localeCompare(String(b[key] ?? "")) * (direction === "desc" ? -1 : 1)
            );
        }
      }
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limited = Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;

      if (method === "GET") return json(readable(table, limited, role));

      const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
      const prefer = headers.get("prefer") ?? "";

      if (method === "PATCH") {
        const updated = limited.map((row) => ({ ...row, ...body, updated_at: NOW }));
        writeBack(db, table, updated);
        return prefer.includes("return=minimal")
          ? new Response("", { status: 204 })
          : json(table === "jarvis_system_state" || table === "jarvis_assistant_policy" ? updated : updated);
      }

      if (method === "POST") {
        const created = {
          id: crypto.randomUUID(),
          ...body,
          created_at: NOW,
          updated_at: NOW
        };
        if (table === "jarvis_language_voices") {
          const voices = db.voices as unknown as Record<string, unknown>[];
          voices.push(created);
        }
        return json([created]);
      }

      if (method === "DELETE") {
        if (table === "jarvis_language_voices") {
          const keep = (db.voices as unknown as Record<string, unknown>[]).filter((row) => !limited.includes(row));
          const removed = (db.voices as unknown as Record<string, unknown>[]).filter((row) => limited.includes(row));
          (db as unknown as { voices: unknown[] }).voices = keep;
          return json(prefer.includes("return=representation") ? removed.map((row) => ({ id: row.id })) : removed);
        }
        return json(limited);
      }
    }

    return json({ message: "not found" }, 404);
  };

  const backend: FakeBackend = {
    db,
    requests,
    fetchStub,
    snapshot,
    get offline() {
      return control.offline;
    },
    set offline(value: string | null) {
      control.offline = value;
    }
  };
  return backend;
}

function session(db: FakeDb, kind: "admin" | "user", refreshToken: string): Record<string, unknown> {
  const token = kind === "admin" ? "admin-access-token" : "user-access-token";
  return {
    access_token: token,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: db.tokens.get(token)
  };
}

function writeBack(db: FakeDb, table: string, updated: Record<string, unknown>[]): void {
  if (table === "jarvis_system_state" && updated[0]) {
    db.systemState = updated[0] as unknown as SystemStateRow;
    return;
  }
  if (table === "jarvis_assistant_policy" && updated[0]) {
    db.assistantPolicy = updated[0] as unknown as AssistantPolicyRow;
    return;
  }
  if (table === "jarvis_languages") {
    const map = new Map(updated.map((row) => [String(row.id), row]));
    db.languages = db.languages.map((row) => (map.has(row.id) ? (map.get(row.id) as unknown as LanguageRow) : row));
    return;
  }
  if (table === "jarvis_language_voices") {
    const key = (row: Record<string, unknown>) => `${row.language_id} ${row.gender}`;
    const map = new Map(updated.map((row) => [key(row), row]));
    db.voices = db.voices.map(
      (row) => (map.has(key(row as unknown as Record<string, unknown>)) ? (map.get(key(row as unknown as Record<string, unknown>)) as unknown as VoiceRow) : row)
    );
  }
}

/**
 * The SELECT view row-level security actually produces.
 *
 * Two policies are in play: "Public can read active JARVIS languages" filters to
 * `enabled` for everyone, and "Admins manage JARVIS languages" is `for all`, so
 * an administrator reading the table sees the disabled rows too. An admin panel
 * that cannot see a disabled row cannot show or re-enable it.
 */
function readable(
  table: string,
  rows: Record<string, unknown>[],
  role: "admin" | "user" | "anon"
): Record<string, unknown>[] {
  if (role === "admin") return rows;
  if (table === "jarvis_languages") return rows.filter((row) => row.enabled === true);
  if (table === "jarvis_language_voices") return rows.filter((row) => row.enabled === true);
  return rows;
}

/** A stored session in the shape the Supabase client persists. */
export function storedSession(
  token = "admin-access-token",
  options: { expiresAt?: number; refreshToken?: string } = {}
): string {
  const user = seedDb().tokens.get(token)!;
  return JSON.stringify({
    access_token: token,
    refresh_token: options.refreshToken ?? (token === "admin-access-token" ? "admin-refresh-token" : "user-refresh-token"),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    user
  });
}