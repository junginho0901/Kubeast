// A screen's buttons with no other way through the AI: cordon, suspend and run now. Each tool presses the button's own
// route as the user, so the permission it asks, the guarded namespaces, the Argo CD guard and its audit row stand. A
// refusal stays a failed call: nothing is said to have happened that did not.

package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

func requiredButtonArg(args map[string]interface{}, name string) (string, error) {
	value := argString(args, name, "")
	if value == "" {
		return "", wrapBadRequest(name + " parameter is required")
	}
	return value, nil
}

// pressAnswer is the route's answer, or the failure its status means, in the route's words.
func pressAnswer(button string, status int, body []byte, err error) (string, error) {
	if err != nil {
		return "", err
	}
	detail := detailOf(body)
	switch {
	case status >= 200 && status < 300:
		return string(body), nil
	case status == http.StatusForbidden:
		return "", fmt.Errorf("%w: %s", errForbidden, detail)
	case status == http.StatusConflict:
		return "", fmt.Errorf("%w: %s", errConflict, detail)
	case status == http.StatusBadRequest, status == http.StatusNotFound, status == http.StatusUnprocessableEntity:
		return "", wrapBadRequest(detail)
	}
	return "", fmt.Errorf("k8s-service %s: status %d: %s", button, status, detail)
}

func handleCordonNode(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	node, err := requiredButtonArg(args, "resource_name")
	if err != nil {
		return "", err
	}
	action := "cordon"
	if argBool(args, "uncordon") {
		action = "uncordon"
	}
	status, body, err := k8sServiceSend(ctx, headers, http.MethodPost, "/nodes/"+url.PathEscape(node)+"/"+action, map[string]interface{}{})
	return pressAnswer(action, status, body, err)
}

// cronJobPath is the CronJob's route, for a call that names both.
func cronJobPath(args map[string]interface{}) (string, error) {
	name, err := requiredButtonArg(args, "resource_name")
	if err != nil {
		return "", err
	}
	namespace, err := requiredButtonArg(args, "namespace")
	if err != nil {
		return "", err
	}
	return "/namespaces/" + url.PathEscape(namespace) + "/cronjobs/" + url.PathEscape(name), nil
}

func handleCronJobSuspend(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	path, err := cronJobPath(args)
	if err != nil {
		return "", err
	}
	if args["suspend"] == nil {
		return "", wrapBadRequest("suspend parameter is required: true suspends the CronJob, false lets it run again")
	}
	status, body, err := k8sServiceSend(ctx, headers, http.MethodPatch, path+"/suspend", map[string]interface{}{"suspend": argBool(args, "suspend")})
	return pressAnswer("suspend", status, body, err)
}

func handleCronJobTrigger(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	path, err := cronJobPath(args)
	if err != nil {
		return "", err
	}
	status, body, err := k8sServiceSend(ctx, headers, http.MethodPost, path+"/trigger", map[string]interface{}{})
	return pressAnswer("trigger", status, body, err)
}
