import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import { rollbackTo } from './migrate-down';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const PERSON_KIND = '20260821150000_add_person_kind';
const OIDC_IDENTITY = '20260824010000_add_oidc_identity';
const SOLUTION_REF = '20260824020000_add_solution_ref';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-identity-migrate-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function beforeIdentity(dbPath: string): void {
  runMigrations(dbPath, FOLDER);
  expect(rollbackTo(dbPath, FOLDER, PERSON_KIND)).toEqual([SOLUTION_REF, OIDC_IDENTITY]);

  const db = openDatabase(dbPath);
  try {
    db.run(
      "INSERT INTO users (id, username, password_hash, created_at) VALUES ('legacy', 'ada', 'hash', 1)",
    );
    db.run(
      "INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at) VALUES ('p', 'Existing plan', 'legacy', 0, 'pert', NULL, 0, 1)",
    );
  } finally {
    db.close();
  }
}

describe('the OIDC identity migration', () => {
  it('preserves legacy accounts and their dependent plans while making passwords optional', () => {
    // A rebuild performed with foreign_keys enabled drops the plan through its
    // ON DELETE action. This count catches that data loss, not merely the new
    // columns' presence.
    const db = tempDb();
    try {
      beforeIdentity(db.path);
      runMigrations(db.path, FOLDER);

      const sqlite = openDatabase(db.path);
      try {
        expect(
          sqlite
            .query<
              { id: string; password_hash: string | null; email: string | null },
              []
            >('SELECT id, password_hash, email FROM users ORDER BY id')
            .all(),
        ).toEqual([{ id: 'legacy', password_hash: 'hash', email: null }]);
        expect(sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project').get()?.n).toBe(
          1,
        );
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, email, idp_issuer, idp_sub, created_at) VALUES ('oidc', 'dany', NULL, 'dany@puni.show', 'https://issuer.example', 'sub-1', 2)",
        );
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('rejects normalized-email and issuer-bound-subject collisions independently', () => {
    const db = tempDb();
    try {
      beforeIdentity(db.path);
      runMigrations(db.path, FOLDER);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, email, idp_issuer, idp_sub, created_at) VALUES ('one', 'one', NULL, 'dany@puni.show', 'https://issuer-a.example', 'same-sub', 2)",
        );
        expect(() =>
          sqlite.run(
            "INSERT INTO users (id, username, password_hash, email, idp_issuer, idp_sub, created_at) VALUES ('email-clash', 'two', NULL, 'DANY@PUNI.SHOW', 'https://issuer-b.example', 'other-sub', 3)",
          ),
        ).toThrow(/UNIQUE constraint failed/);
        expect(() =>
          sqlite.run(
            "INSERT INTO users (id, username, password_hash, email, idp_issuer, idp_sub, created_at) VALUES ('subject-clash', 'three', NULL, 'other@puni.show', 'https://issuer-a.example', 'same-sub', 4)",
          ),
        ).toThrow(/UNIQUE constraint failed/);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('rolls legacy accounts back without deleting dependent plans', () => {
    const db = tempDb();
    try {
      beforeIdentity(db.path);
      runMigrations(db.path, FOLDER);
      expect(rollbackTo(db.path, FOLDER, PERSON_KIND)).toEqual([SOLUTION_REF, OIDC_IDENTITY]);

      const sqlite = openDatabase(db.path);
      try {
        expect(
          sqlite
            .query<{ name: string; notnull: number }, []>('PRAGMA table_info(users)')
            .all()
            .map(({ name, notnull }) => ({ name, notnull })),
        ).toEqual([
          { name: 'id', notnull: 0 },
          { name: 'username', notnull: 1 },
          { name: 'password_hash', notnull: 1 },
          { name: 'created_at', notnull: 1 },
        ]);
        expect(sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
        expect(sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project').get()?.n).toBe(
          1,
        );
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('locks OIDC-only accounts during downgrade and restores every identity on re-apply', async () => {
    const db = tempDb();
    try {
      beforeIdentity(db.path);
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "UPDATE users SET email = 'ada@example.com', idp_issuer = 'https://issuer.example', idp_sub = 'legacy-sub' WHERE id = 'legacy'",
        );
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, email, idp_issuer, idp_sub, created_at) VALUES ('oidc', 'dany', NULL, 'dany@puni.show', 'https://issuer.example', 'sub-1', 2)",
        );
        sqlite.run(
          "INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at) VALUES ('oidc-plan', 'OIDC plan', 'oidc', 0, 'pert', NULL, 0, 2)",
        );
      } finally {
        sqlite.close();
      }

      expect(rollbackTo(db.path, FOLDER, PERSON_KIND)).toEqual([SOLUTION_REF, OIDC_IDENTITY]);
      const downgraded = openDatabase(db.path);
      try {
        const locked = downgraded
          .query<{ password_hash: string }, []>("SELECT password_hash FROM users WHERE id = 'oidc'")
          .get()?.password_hash;
        expect(locked).toBeString();
        expect(await Bun.password.verify('not-the-locked-value', locked ?? '')).toBe(false);
        expect(
          downgraded
            .query<{ users: number; projects: number; identities: number; migrations: number }, []>(
              `SELECT
              (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM project) AS projects,
              (SELECT COUNT(*) FROM oidc_identity_downgrade) AS identities,
              (SELECT COUNT(*) FROM __drizzle_migrations) AS migrations`,
            )
            .get(),
        ).toEqual({ users: 2, projects: 2, identities: 2, migrations: 26 });
      } finally {
        downgraded.close();
      }

      runMigrations(db.path, FOLDER);
      const restored = openDatabase(db.path);
      try {
        expect(
          restored
            .query<
              {
                id: string;
                password_hash: string | null;
                email: string | null;
                idp_issuer: string | null;
                idp_sub: string | null;
              },
              []
            >('SELECT id, password_hash, email, idp_issuer, idp_sub FROM users ORDER BY id')
            .all(),
        ).toEqual([
          {
            id: 'legacy',
            password_hash: 'hash',
            email: 'ada@example.com',
            idp_issuer: 'https://issuer.example',
            idp_sub: 'legacy-sub',
          },
          {
            id: 'oidc',
            password_hash: null,
            email: 'dany@puni.show',
            idp_issuer: 'https://issuer.example',
            idp_sub: 'sub-1',
          },
        ]);
        expect(
          restored
            .query<{ users: number; projects: number; migrations: number }, []>(
              `SELECT
              (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM project) AS projects,
              (SELECT COUNT(*) FROM __drizzle_migrations) AS migrations`,
            )
            .get(),
        ).toEqual({ users: 2, projects: 2, migrations: 28 });
        expect(
          restored
            .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oidc_identity_downgrade')
            .get()?.n,
        ).toBe(0);
      } finally {
        restored.close();
      }
    } finally {
      db.cleanup();
    }
  });
});
