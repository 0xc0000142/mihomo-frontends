FNR==1 { default_route=0 }
{
    if ($1=="default" || $1=="0.0.0.0/0" || $1=="::/0") default_route=1
    else if ($1!="nexthop") default_route=0
    if (!default_route) next
    for (position=1; position<NF; position++) {
        if ($position=="dev" && $(position+1) ~ /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/) {
            interface_name=$(position+1)
            if (!seen[interface_name]++) print interface_name
        }
    }
}
