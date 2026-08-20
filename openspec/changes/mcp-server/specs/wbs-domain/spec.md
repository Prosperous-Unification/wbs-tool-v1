## ADDED Requirements

### Requirement: The API is reachable as an MCP server, and its tools are the API

A wbs deployment SHALL be reachable by an MCP client, and the tools that client
sees SHALL be derived from the API's own OpenAPI document rather than maintained
beside it. A route the API gains SHALL either appear as a tool or appear in a
named exclusion list; there SHALL be no third outcome in which it is silently
absent.

A tool SHALL name its operation's identifier, and SHALL carry that operation's
own description unedited — including a description that says its body schema is
documentation rather than validation.

#### Scenario: a new route cannot go unnoticed

- **GIVEN** an OpenAPI document from which tools are generated
- **WHEN** the document gains an operation that is in no exclusion list
- **THEN** the generated tool list contains it, and a check comparing the two
  fails until it does

#### Scenario: an exclusion that stopped matching is a failure

- **GIVEN** an exclusion list naming operations that are not to become tools
- **WHEN** the document no longer contains one of those operations
- **THEN** the check fails, rather than the list silently narrowing

#### Scenario: an operation with no identifier is refused

- **WHEN** an operation carries no operation id
- **THEN** generation throws, and no tool name is synthesised from its path

### Requirement: An MCP write is an ordinary write

A write made through MCP SHALL go through the same journalled route the front end
calls. It SHALL be undoable, redoable, and visible in the project's history
exactly as a write made in a browser is. The MCP server SHALL hold no plan state
of its own: no database, no cached schedule, no second copy of a tree.

#### Scenario: an agent's edit undoes

- **GIVEN** a plan edited through an MCP tool
- **WHEN** undo is invoked on that project
- **THEN** the edit reverses, the same as an edit made in the front end

#### Scenario: derived numbers are not answered from a cache

- **WHEN** a work item is read after a write that moves the schedule
- **THEN** the values come from the API's recomputation of the tree, not from
  anything the MCP server retained

### Requirement: A refusal reaches the caller as the API's own code

When the API refuses a request, the MCP tool result SHALL be an error carrying
the API's status and its refusal code verbatim. A refusal SHALL NOT be summarised,
translated, or reported as a generic failure: the codes are the vocabulary a
caller corrects itself with.

An expired or invalid account token SHALL be reported as such, and SHALL NOT be
refreshed by the server, which holds no credential to refresh it with.

#### Scenario: a refused write names why

- **GIVEN** a write the API refuses with a 400 and a refusal code
- **WHEN** it is made through an MCP tool
- **THEN** the tool result is an error containing that code verbatim

#### Scenario: an expired token is not mistaken for a bad request

- **WHEN** the API answers 401
- **THEN** the tool result names the token, not the request body

### Requirement: An MCP server acts as exactly one account

An MCP server process SHALL carry one account token, given to it at start, and
SHALL send it on every call. It SHALL NOT expose a tool that registers an
account, logs one in, or issues a token. Every client of one process therefore
acts as that one account, and the server's documentation SHALL say so.

#### Scenario: no tool mints a credential

- **WHEN** the tool list is generated
- **THEN** it contains no register, login, or token-issuing operation

#### Scenario: a server with no token does not start

- **WHEN** the process starts with no account token configured
- **THEN** it throws, naming the missing configuration, and serves nothing
