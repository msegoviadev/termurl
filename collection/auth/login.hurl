# Logs in and captures the auth token
POST {{host}}/auth/login
Content-Type: application/json
{
  "email": "{{email}}",
  "password": "{{password}}"
}
HTTP 200
[Captures]
token: jsonpath "$.token"
[Asserts]
status == 200
jsonpath "$.token" exists
