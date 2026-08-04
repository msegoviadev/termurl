# Creates a new user
POST {{host}}/users
Authorization: Bearer {{token}}
Content-Type: application/json
{
  "name": "{{name}}",
  "email": "{{email}}"
}
HTTP 201
[Captures]
user_id: jsonpath "$.id"
[Asserts]
status == 201
