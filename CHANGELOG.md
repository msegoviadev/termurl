# Changelog

All notable changes to termurl are documented here.

## [0.7.0](https://github.com/msegoviadev/termurl/compare/v0.6.0...v0.7.0) (2026-09-17)


### Features

* add f/F/t/T char-search motions and fix shifted operator dispatch ([3c848ab](https://github.com/msegoviadev/termurl/commit/3c848ab63b78739e818524806ccdc26dc00137c4))
* cycle request variants with tab in the editor ([d54aa9b](https://github.com/msegoviadev/termurl/commit/d54aa9b55651aed3c02080a93b90067f137f9646))
* toggle comments with space / in the editors ([cdcc164](https://github.com/msegoviadev/termurl/commit/cdcc164b985769800cfe879827430e2570c85942))

## [0.6.0](https://github.com/msegoviadev/termurl/compare/v0.5.0...v0.6.0) (2026-09-14)


### Features

* add quarter-page and line-edge shift motions ([54f69d5](https://github.com/msegoviadev/termurl/commit/54f69d500fc2c4b2df41719a9e7a6bc32906b067))


### Performance Improvements

* cache row renderables so selection moves repaint only two rows ([0741c7e](https://github.com/msegoviadev/termurl/commit/0741c7e30a25fc54118a97264f464b92f20ffa7c))

## [0.5.0](https://github.com/msegoviadev/termurl/compare/v0.4.0...v0.5.0) (2026-09-14)


### Features

* add a filter to the flows list and drop unused shortcuts ([70cc263](https://github.com/msegoviadev/termurl/commit/70cc263e78f682ca7973e6e62371682a6d4d8fcb))
* add a root node to the file trees with recursive folder toggles ([ebc24de](https://github.com/msegoviadev/termurl/commit/ebc24de85eb96b8a8508a9b7dcab77f9c85d78e8))
* add named flows and unified request/flow file management ([6ed2928](https://github.com/msegoviadev/termurl/commit/6ed292827366a82d0c124610e532733b3f796570))
* color request rows by HTTP method and simplify list labels ([74767c7](https://github.com/msegoviadev/termurl/commit/74767c73b7df3428ae3674f9c26c62c0c64d251b))
* move requests under &lt;collection&gt;/requests ([15a2d57](https://github.com/msegoviadev/termurl/commit/15a2d57cac5b76eed20304e6d37439ec3278fe83))
* run the request queue with enter and clear it with shift-tab ([faabd4e](https://github.com/msegoviadev/termurl/commit/faabd4edf3375fe7a8e9ebb3f0de98b5ffe1e60a))
* show flow names in the history list ([c291f04](https://github.com/msegoviadev/termurl/commit/c291f042020c2cac81c6eae407fab45bb62056e2))
* unify requests/flows list styling and create input ([46bec0c](https://github.com/msegoviadev/termurl/commit/46bec0c7b6b9a661b16f4c4735fcd52e80226997))


### Bug Fixes

* make pane divider resize drag reliable and show a resize cursor ([957d0ee](https://github.com/msegoviadev/termurl/commit/957d0ee7ef4dc5977feae0b90a48b8d0614a874f))
* reflow history day rules when the list width changes ([eec6e1e](https://github.com/msegoviadev/termurl/commit/eec6e1e95f21d10cfbc25eff9adc2075fdefa1e5))

## [0.4.0](https://github.com/msegoviadev/termurl/compare/v0.3.0...v0.4.0) (2026-09-13)


### Features

* dirty buffer tracking, vim command line, and mode titles ([da61de3](https://github.com/msegoviadev/termurl/commit/da61de33b340a466f97fa42e0e4816943b99376c))
* group history by day and color-code run statuses ([aef7d09](https://github.com/msegoviadev/termurl/commit/aef7d0938ad5aba3527847ff49c5bde349767572))
* nvim-style editor panes with line number gutters, per-pane command line, and extended save/quit commands ([7efe4c3](https://github.com/msegoviadev/termurl/commit/7efe4c37a044ddca89bc2b41952a9ef9e321cd5d))


### Bug Fixes

* update focused textarea colors on theme switch ([77e18a7](https://github.com/msegoviadev/termurl/commit/77e18a7bc9b729b0108a668ab4ffe2b04958e427))


### Performance Improvements

* cache file reads on hot paths and update history incrementally ([5cbd4f3](https://github.com/msegoviadev/termurl/commit/5cbd4f329182c5ca6416142fe38e9cda3bd2dbe8))

## [0.3.0](https://github.com/msegoviadev/termurl/compare/v0.2.0...v0.3.0) (2026-09-07)


### Features

* follow omarchy theme with theme = "system" ([ddf53a9](https://github.com/msegoviadev/termurl/commit/ddf53a99b924a0e14a32cac68a2f19afbc62c728))
* live-reload palette on omarchy theme switch ([1dee4d1](https://github.com/msegoviadev/termurl/commit/1dee4d17f08bf3a2806d5f4d08d61c1d620270be))

## [0.2.0](https://github.com/msegoviadev/termurl/compare/v0.1.0...v0.2.0) (2026-09-05)


### Features

* improve pane resizing and text selection ([0255748](https://github.com/msegoviadev/termurl/commit/02557489db13aaeff5cc06657dcc1c3132e8a436))
* request variants with tab strip and shift-enter flow run ([882d39f](https://github.com/msegoviadev/termurl/commit/882d39f40cb4b4380fe2cc31c0862602367195a0))
* show request/response body and section headers in output ([79a0d7a](https://github.com/msegoviadev/termurl/commit/79a0d7ad63fe081ca52855b5819469f19a681395))
* toggle folders with l and scroll request list to selection ([a2e1ba2](https://github.com/msegoviadev/termurl/commit/a2e1ba2b11833514e5d834897300673e8becdd25))
* unify environment secrets, add copy-as-curl, and fix layout issues ([521ada0](https://github.com/msegoviadev/termurl/commit/521ada0242a69c2726b8d1fa5c5400ead9b5ffcd))

## 0.1.0 (2026-08-07)


### Features

* initialize termurl ([28bd05e](https://github.com/msegoviadev/termurl/commit/28bd05e95d7470a7618a71e8084631dc6891c5c0))
* prepare termurl for public release ([b0cac16](https://github.com/msegoviadev/termurl/commit/b0cac1669ea3d233e28c8ae7c41ce3a166b7f00b))


### Bug Fixes

* set initial release version ([90c9107](https://github.com/msegoviadev/termurl/commit/90c9107c5359d723f676abe1ef00c3500eea8bc2))

## [0.1.0] - 2026-08-06

- Initial public release.
