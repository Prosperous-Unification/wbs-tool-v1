# A wiki release is a toolkit, not a certification

An activation binds one candidate identity, so an archive published from this repository certifies
exactly one commit of this repository and refuses every commit of any other. A release for other
repositories therefore ships only the roles that do not vary — launcher, snapshotter, validator
bundle, the TypeScript runtime closure and the root descriptor constants — plus a standalone
preparer; each consumer produces its own policy, mapping, authority, bindings, evidence, review
receipt, manifest and selection from its own commit, and `TOOL_WIKI_ACTIVATION_VERSION` stays the
consumer's own 40-hexadecimal commit.

## Considered Options

The plan asked for a certified archive published under a `wiki-vMAJOR.MINOR.PATCH` tag, with the
tag itself accepted as `TOOL_WIKI_ACTIVATION_VERSION` during a compatibility window. That archive
would be an ordinary per-commit activation of one commit of this repository: a consumer setting the
variable to the tag would download an archive whose authority names a candidate identity no
candidate of theirs can equal, and the check would refuse every pull request with a per-commit
refusal that looks like a configuration bug. Shipping a review receipt with it would be worse — it
would invite a consumer to embed a review of another repository's tree in its own authority. The
tag survives as provenance: a `toolkit-release` root descriptor nothing on the admission path reads.

## Consequences

A consumer cannot adopt the wiki by setting three variables alone; it must author a policy, a module
mapping and relationship facts, obtain a review record for one of its own commits, and run the
preparer to produce its first activation. That is more work than the plan promised, and it is the
only shape in which the green check means what it says.
