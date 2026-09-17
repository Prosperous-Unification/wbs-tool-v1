/**
 * The wiki product contributes no lint fences of its own yet: `wiki-cli` is one Bun CLI with no
 * framework plugins, and the root config's scope, runtime and ring constraints already hold it.
 *
 * The file exists anyway because discovery is decided on the file, not on what importing it
 * raises, and a product that ships fences later adds them here rather than in the root config.
 * It default-exports a function of the shared constants like every other product policy, so the
 * contract is the same one `tools/tool-devsync/product-policies.mjs` enforces for `apps/wbs`.
 */
export default () => [];
