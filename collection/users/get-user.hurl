# Gets a single user by id
GET {{host}}/users/{{user_id}}
Authorization: Bearer {{token}}

HTTP 200
[Asserts]
status == 200
jsonpath "$.id" exists
