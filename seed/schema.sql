
DROP TABLE IF EXISTS audit_log, invoices, subscriptions, users, organizations CASCADE;

CREATE TABLE organizations (
    id         serial PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id         serial PRIMARY KEY,
    org_id     integer NOT NULL REFERENCES organizations(id),
    email      text,                       -- nullable + non-unique on purpose
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
    id         serial PRIMARY KEY,
    org_id     integer NOT NULL REFERENCES organizations(id),
    plan       text NOT NULL,
    status     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
    id           serial PRIMARY KEY,
    org_id       integer NOT NULL REFERENCES organizations(id),
    amount_cents integer NOT NULL,
    status       text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
    id         serial PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES users(id),
    action     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON audit_log(user_id);
