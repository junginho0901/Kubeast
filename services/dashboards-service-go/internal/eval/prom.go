package eval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Querier runs what grading needs against a store.
type Querier interface {
	// Query runs an instant query and counts the series it returns (a
	// scalar or string counts as one).
	Query(ctx context.Context, expr string) (int, error)
	// LabelValues counts a label's values on the series of match ("" = all).
	LabelValues(ctx context.Context, label, match string) (int, error)
	// Sum runs an instant query and adds up its values (with the count).
	Sum(ctx context.Context, expr string) (float64, int, error)
}

// Prometheus is a Querier on Prometheus' HTTP API at a base URL.
type Prometheus struct {
	Base   string
	Client *http.Client
}

func (p Prometheus) get(ctx context.Context, path string, params url.Values) (json.RawMessage, error) {
	c := p.Client
	if c == nil {
		c = &http.Client{Timeout: 15 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(p.Base, "/")+path+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	var out struct {
		Status string          `json:"status"`
		Data   json.RawMessage `json:"data"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("HTTP %d: not a Prometheus answer", resp.StatusCode)
	}
	if out.Status != "success" {
		return nil, errors.New(out.Error)
	}
	return out.Data, nil
}

func (p Prometheus) Query(ctx context.Context, expr string) (int, error) {
	data, err := p.get(ctx, "/api/v1/query", url.Values{"query": {expr}})
	if err != nil {
		return 0, err
	}
	var res struct {
		ResultType string          `json:"resultType"`
		Result     json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(data, &res); err != nil {
		return 0, err
	}
	switch res.ResultType {
	case "vector", "matrix":
		var list []json.RawMessage
		if err := json.Unmarshal(res.Result, &list); err != nil {
			return 0, err
		}
		return len(list), nil
	}
	return 1, nil
}

func (p Prometheus) Sum(ctx context.Context, expr string) (float64, int, error) {
	data, err := p.get(ctx, "/api/v1/query", url.Values{"query": {expr}})
	if err != nil {
		return 0, 0, err
	}
	var res struct {
		ResultType string          `json:"resultType"`
		Result     json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(data, &res); err != nil {
		return 0, 0, err
	}
	var pairs [][2]json.RawMessage
	switch res.ResultType {
	case "vector":
		var list []struct {
			Value [2]json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal(res.Result, &list); err != nil {
			return 0, 0, err
		}
		for _, v := range list {
			pairs = append(pairs, v.Value)
		}
	case "scalar":
		var v [2]json.RawMessage
		if err := json.Unmarshal(res.Result, &v); err != nil {
			return 0, 0, err
		}
		pairs = append(pairs, v)
	default:
		return 0, 0, fmt.Errorf("sum of a %s result", res.ResultType)
	}
	sum := 0.0
	for _, p := range pairs {
		var s string
		if json.Unmarshal(p[1], &s) == nil {
			if f, err := strconv.ParseFloat(s, 64); err == nil {
				sum += f
			}
		}
	}
	return sum, len(pairs), nil
}

func (p Prometheus) LabelValues(ctx context.Context, label, match string) (int, error) {
	params := url.Values{}
	if match != "" {
		params.Set("match[]", match)
	}
	data, err := p.get(ctx, "/api/v1/label/"+url.PathEscape(label)+"/values", params)
	if err != nil {
		return 0, err
	}
	var vals []string
	if err := json.Unmarshal(data, &vals); err != nil {
		return 0, err
	}
	return len(vals), nil
}
