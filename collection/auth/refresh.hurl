# Refreshes an expired auth token
POST {{host}}/auth/refresh
Content-Type: application/json
{
  "refresh_token": "{{refresh_token}}"
}
HTTP 200
[Captures]
token: jsonpath "$.token"
[Asserts]
status == 200
