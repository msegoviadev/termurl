# Dev WireMock

This fixture provides the local API used by the dev environment at
`http://localhost:3000`.

## Start

```bash
cd wiremock
docker compose up -d
```

## Stop

```bash
cd wiremock
docker compose down
```

The login, create-user, get-user, list-users, refresh, and delete-user mappings
are deterministic. Login captures `dev-token`, and the user endpoints require
that bearer token.
