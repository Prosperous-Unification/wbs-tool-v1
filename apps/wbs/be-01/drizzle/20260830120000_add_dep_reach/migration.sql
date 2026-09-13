-- How far into a predecessor a dependency reaches, per project. `whole-item` —
-- the successor waits for the predecessor's last slice — is the default, so it
-- applies to every row that already exists and every plan with a multi-step
-- predecessor changes shape on the release that carries this. That is the
-- intent of `dep-reach-whole-item`, not a side effect: the 2026-08-11
-- `anchor-slice` rule becomes something a project asks for.
--
-- Additive, so the outgoing colour keeps reading `project` while green migrates.
ALTER TABLE `project` ADD `dep_reach` text DEFAULT 'whole-item' NOT NULL;
