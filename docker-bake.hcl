group "ci" {
  targets = ["runtime-ci", "build-job-ci"]
}

target "runtime-ci" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "runtime"
  platforms  = ["linux/amd64"]
  tags       = ["circuits:ci"]
  output     = ["type=docker"]
  cache-from = [
    "type=gha",
    "type=gha,scope=wattful-runtime-ci",
    "type=gha,scope=wattful-build-job-ci",
  ]
  cache-to = ["type=gha,scope=wattful-runtime-ci,mode=max"]
}

target "build-job-ci" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "build-job"
  platforms  = ["linux/amd64"]
  tags       = ["wattful-iron-build-job:ci"]
  output     = ["type=docker"]
  cache-from = [
    "type=gha",
    "type=gha,scope=wattful-runtime-ci",
    "type=gha,scope=wattful-build-job-ci",
  ]
  cache-to = ["type=gha,scope=wattful-build-job-ci,mode=max"]
}
