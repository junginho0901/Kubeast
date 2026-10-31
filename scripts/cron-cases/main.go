// The next run of a CronJob schedule as kube-controller-manager v1.37 computes it: formatSchedule (a schedule with
// "TZ" in it as it is; else "TZ=<spec.timeZone> " in front, and a zone it cannot load starts nothing), robfig/cron
// v3.0.1 ParseStandard, Next. Reads {"zone","schedule","from"} lines, writes them back with "next" (RFC 3339 UTC, null
// for none). run.sh builds it against that robfig version; frontend/src/utils/cron.cases.json is its output.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

type tcase struct {
	Zone     string  `json:"zone"`
	Schedule string  `json:"schedule"`
	From     string  `json:"from"`
	Next     *string `json:"next"`
}

func next(c tcase) (*string, error) {
	from, err := time.Parse(time.RFC3339Nano, c.From)
	if err != nil {
		return nil, err
	}
	spec := c.Schedule
	if !strings.Contains(spec, "TZ") && c.Zone != "" {
		if _, err := time.LoadLocation(c.Zone); err != nil {
			return nil, nil
		}
		spec = fmt.Sprintf("TZ=%s %s", c.Zone, spec)
	}
	var s cron.Schedule
	func() {
		defer func() { _ = recover() }() // the controller's ParseCronScheduleWithPanicRecovery
		s, err = cron.ParseStandard(spec)
	}()
	if s == nil || err != nil {
		return nil, nil
	}
	t := s.Next(from)
	if t.IsZero() {
		return nil, nil
	}
	v := t.UTC().Format(time.RFC3339)
	return &v, nil
}

func main() {
	in := bufio.NewScanner(os.Stdin)
	out := json.NewEncoder(os.Stdout)
	for in.Scan() {
		var c tcase
		if err := json.Unmarshal(in.Bytes(), &c); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		n, err := next(c)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		c.Next = n
		_ = out.Encode(c)
	}
}
