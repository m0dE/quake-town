/*
	teams.qc

	Red / blue teams for 2on2, 4on4, CTF and Clan Arena: balanced auto-team,
	team colours, the "team" command and userinfo changes.

	Copyright (C) 2026 Quake Town contributors

	This program is free software; you can redistribute it and/or
	modify it under the terms of the GNU General Public License
	as published by the Free Software Foundation; either version 2
	of the License, or (at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
*/

float   setinfo_guard;          // our own qt_setinfo calls don't re-enter

float(entity a, entity b) SameTeam =
{
	if (!a.qteam)
		return FALSE;
	return a.qteam == b.qteam;
};

string(float t) TeamName =
{
	if (t == TEAM_RED)
		return "red";
	if (t == TEAM_BLUE)
		return "blue";
	return "";
};

string(float t) TeamTitle =
{
	if (t == TEAM_RED)
		return "RED";
	if (t == TEAM_BLUE)
		return "BLUE";
	return "";
};

float(string s) TeamFromString =
{
	if (s == "red" || s == "RED" || s == "Red" || s == "1")
		return TEAM_RED;
	if (s == "blue" || s == "BLUE" || s == "Blue" || s == "2")
		return TEAM_BLUE;
	return TEAM_NONE;
};

// players on team t, not counting "ignore"
float(float t, entity ignore) Team_Count =
{
	local entity p;
	local float n;

	n = 0;
	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected && p.qteam == t && p != ignore)
			n = n + 1;
		p = find (p, classname, "player");
	}
	return n;
};

// writes team and QW team colours (red 4, blue 13) into the userinfo
void(entity p, float t) Team_Set =
{
	p.qteam = t;
	p.team = t;             // QW's .team too (1 red, 2 blue): engine aim, bots
	setinfo_guard = TRUE;
	if (t == TEAM_RED)
	{
		qt_setinfo (p, "team", "red");
		qt_setinfo (p, "topcolor", "4");
		qt_setinfo (p, "bottomcolor", "4");
	}
	else if (t == TEAM_BLUE)
	{
		qt_setinfo (p, "team", "blue");
		qt_setinfo (p, "topcolor", "13");
		qt_setinfo (p, "bottomcolor", "13");
	}
	setinfo_guard = FALSE;
};

/*
============
Team_AutoAssign

Joins the smaller team; the player's own "team" userinfo wins when it does
not unbalance the teams; on a tie the team that is behind gets the player.
============
*/
void(entity p) Team_AutoAssign =
{
	local float want, c1, c2, t;

	if (!qt_teammode)
	{
		p.qteam = TEAM_NONE;
		return;
	}

	want = TeamFromString (infokey (p, "team"));
	c1 = Team_Count (TEAM_RED, p);
	c2 = Team_Count (TEAM_BLUE, p);

	if (want == TEAM_RED && c1 <= c2)
		t = TEAM_RED;
	else if (want == TEAM_BLUE && c2 <= c1)
		t = TEAM_BLUE;
	else if (c1 < c2)
		t = TEAM_RED;
	else if (c2 < c1)
		t = TEAM_BLUE;
	else if (qt_mode == MODE_CTF && team2caps < team1caps)
		t = TEAM_BLUE;
	else if (qt_mode != MODE_CTF && team2score < team1score)
		t = TEAM_BLUE;
	else
		t = TEAM_RED;

	Team_Set (p, t);
	bprint (PRINT_HIGH, p.netname);
	bprint (PRINT_HIGH, " joins the ");
	bprint (PRINT_HIGH, TeamTitle (t));
	bprint (PRINT_HIGH, " team\n");
};

/*
============
Team_Request

A player asks for team t ("team" command or a userinfo change).
Allowed during warmup when it does not unbalance the teams.
============
*/
void(entity p, float t) Team_Request =
{
	if (!qt_teammode)
		return;
	if (t == p.qteam)
	{
		Team_Set (p, t);        // keep the team colours
		return;
	}
	if (t != TEAM_RED && t != TEAM_BLUE)
	{
		sprint (p, PRINT_HIGH, "The teams are red and blue\n");
		Team_Set (p, p.qteam);
		return;
	}
	if (match_phase != PHASE_WARMUP)
	{
		sprint (p, PRINT_HIGH, "You can't change teams during a match\n");
		Team_Set (p, p.qteam);
		return;
	}
	if (Team_Count (t, p) > Team_Count (p.qteam, p))
	{
		sprint (p, PRINT_HIGH, "That team has more players\n");
		Team_Set (p, p.qteam);
		return;
	}
	CTF_DropFlag (p);
	Team_Set (p, t);
	bprint (PRINT_HIGH, p.netname);
	bprint (PRINT_HIGH, " switched to the ");
	bprint (PRINT_HIGH, TeamTitle (t));
	bprint (PRINT_HIGH, " team\n");
};

/*
============
UserInfo_Changed

Called by the engine (self = player) after a userinfo change.
In team modes the mod owns team and colours.
============
*/
void() UserInfo_Changed =
{
	local float wt, exact;

	if (setinfo_guard)
		return;
	if (!qt_teammode || !self.qt_connected)
		return;

	// infokey may share one buffer (QW): use each result before the next call
	wt = TeamFromString (infokey (self, "team"));
	exact = (infokey (self, "team") == TeamName (self.qteam));
	if (wt == self.qteam)
	{
		// the colours are the team's
		if (!exact)
			Team_Set (self, self.qteam);
		else if (self.qteam == TEAM_RED)
		{
			if (infokey (self, "topcolor") != "4")
				Team_Set (self, self.qteam);
			else if (infokey (self, "bottomcolor") != "4")
				Team_Set (self, self.qteam);
		}
		else if (self.qteam == TEAM_BLUE)
		{
			if (infokey (self, "topcolor") != "13")
				Team_Set (self, self.qteam);
			else if (infokey (self, "bottomcolor") != "13")
				Team_Set (self, self.qteam);
		}
		return;
	}
	Team_Request (self, wt);
};
