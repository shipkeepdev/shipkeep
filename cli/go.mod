module github.com/shipkeepdev/shipkeep/cli

go 1.26.0

require (
	github.com/shipkeepdev/shipkeep/lib v0.0.0
	golang.org/x/term v0.47.0
)

require (
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.3 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/shipkeepdev/shipkeep/lib => ../lib
