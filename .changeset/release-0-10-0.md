---
'pinnace': minor
---

Pin the cloud-init agent version to `0.10.0`, the version this release publishes.

The headline change is that `status`'s three external checks (`announced`, the CID-gateway probe, the eth.limo probe) are now three-valued rather than boolean, which changes the reported shape: a check that could not RUN reports `unknown` with its reason instead of a confident negative. A live box reported `announced=false` for a site the delegated router was listing correctly at that moment; the lookup had failed on the client and a failed lookup was indistinguishable from a real negative.
