module github.com/samuelmbabhazi/shipkeep/agent

go 1.26.0

require (
	github.com/samuelmbabhazi/shipkeep/lib v0.0.0
	gopkg.in/yaml.v3 v3.0.1
)

replace github.com/samuelmbabhazi/shipkeep/lib => ../lib
