# Lists users, paginated
GET {{host}}/users
Authorization: Bearer {{token}}
[Query]
page: 1
page_size: 20
HTTP 200
[Asserts]
status == 200
jsonpath "$.users" isCollection
